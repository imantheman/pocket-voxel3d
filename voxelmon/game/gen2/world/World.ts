// The Gen 2 overworld: a port of gen1recomp src/world/gen2/World.lua at
// bdfac727 (MIT), bryanthaboi/gen1recomp's last MIT commit.
//
// World keeps every piece of Brian's overworld logic and state -- COLL_*
// collision, warps, connections, the map setup chain, events, NPC movement,
// trainers' sight, step events, field moves, fades, the map name sign, the
// palette/time-of-day selection and the camera focus. What it does NOT keep
// is the LÖVE drawing: the voxel world is drawn by platform/worldview.ts,
// which reads World:viewState() (see the WorldView comment block below) each
// frame. Text boxes, menus, battles and screens are reached through TextBox,
// Screens, Battle and the ui/ modules exactly as the Lua reaches them.
//
// Lua line citations are `// Lua: World.lua:N`.

// Lua: World.lua:1-4
// Gen 2 overworld vertical slice: COLL_* collision, warps, connected
// neighbor strips (RBY-style), seamless edge crossings, survey zoom,
// OW sprites + SPRITEMOVEDATA walk/spin paths on current map and neighbor
// strips.  Mounted from Game2; leaves Gen 1 Map.lua alone.

// Lua: World.lua:6-74 (the requires). Drawing-only modules are not imported
// (PixelCanvas, Pipelines, Playfield, SpriteRenderer, Tilt, Zoom, Renderer):
// nothing here paints the world. drawOverlay()'s Gold-screen UI (the map
// name sign, the pokepic window) uses G, GbcPalette and Assets the way the
// Lua's draws do. The lazy `require`s inside function bodies (Phone, PhoneRing, Happiness, Sound, GameVersion,
// ScreenPosition, Pokegear) are hoisted to here.
import { osTime } from "../platform/clock.ts";
import { Apricorns } from "../core/Apricorns.ts";
import { Bag } from "../shared/inventory/Bag.ts";
import { Battle } from "../battle/Battle.ts";
import { BattleMusic } from "../battle/BattleMusic.ts";
import { Bike } from "./Bike.ts";
import { BorderFill } from "./BorderFill.ts";
import { Boxes } from "../core/Boxes.ts";
import { Breeding } from "../core/Breeding.ts";
import { BugContest } from "../core/BugContest.ts";
import { CallAsm } from "../script/CallAsm.ts";
import { Camera } from "../shared/render/Camera.ts";
import { Clock } from "../core/Clock.ts";
import { CatchTutorial } from "../core/CatchTutorial.ts";
import { Catching } from "../battle/Catching.ts";
import { Decorations } from "../core/Decorations.ts";
import { MomShopping } from "../core/MomShopping.ts";
import { CmdQueue } from "./CmdQueue.ts";
import { Encounter } from "../battle/Encounter.ts";
import { ChoiceBox } from "../shared/ui/ChoiceBox.ts";
import { Events } from "./Events.ts";
import { FieldMoves } from "./FieldMoves.ts";
import { FixedStep } from "../shared/core/FixedStep.ts";
import { Follower } from "./Follower.ts";
import { Font } from "../shared/render/Font.ts";
// Two call sites only (World:step's tail, World:interact), both no-ops until
// a mod has taken a facade (src/mods/Gen2Compat.lua).
import { Gen2Compat as Gen1Facade } from "../shared/mods/Gen2Compat.ts";
import { Save as Gen2Save } from "../core/Save.ts";
import { HallOfFame } from "../core/HallOfFame.ts";
import { HiddenItems } from "./HiddenItems.ts";
import { Mail } from "../core/Mail.ts";
import { Map } from "./Map.ts";
import { MapNameSign } from "./MapNameSign.ts";
import { Palettes } from "./Palettes.ts";
import { UnownWords } from "./UnownWords.ts";
import { Mon } from "../battle/Mon.ts";
import { Movement, type Dir, type MovementAction } from "../script/Movement.ts";
import { Music } from "../shared/core/Music.ts";
import { NPC } from "./Npc.ts";
import { Party } from "../shared/pokemon/Party.ts";
import { Sprites } from "../shared/pokemon/Sprites.ts";
import { Permissions } from "./Permissions.ts";
import { Player, SpriteHandle, type ActorView } from "./Player.ts";
import { Pokerus } from "../core/Pokerus.ts";
import { Roamers } from "../core/Roamers.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { Sound } from "../shared/core/Sound.ts";
import { StepEvents } from "./StepEvents.ts";
import { TileAttrs } from "./TileAttrs.ts";
import { OamFootprint } from "./OamFootprint.ts";
import { MapAttrGrid } from "./MapAttrGrid.ts";
import { Strings } from "../shared/core/Strings.ts";
import { TextBox } from "../shared/render/TextBox.ts";
import { TrainerHouse } from "./TrainerHouse.ts";
import { Trainers } from "./Trainers.ts";
import { Unown } from "../core/Unown.ts";
import { Vm } from "../script/Vm.ts";
import { Assets } from "../shared/render/Assets.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { G } from "../platform/screen.ts";
import { Phone } from "../core/Phone.ts";
import { PhoneRing } from "../core/PhoneRing.ts";
import { Happiness } from "../core/Happiness.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { Logger } from "../shared/core/Logger.ts";
import { ScreenPosition } from "../shared/core/ScreenPosition.ts";
import { Pokegear } from "../ui/Pokegear.ts";
import { loadGenerated as loadGeneratedTable } from "../platform/data.ts";
import { random } from "../platform/rng.ts";
import {
  truthy, sub, idiv, mod, tostring, tonumber, format, insertAt, removeAt, sortedKeys,
} from "../platform/lua.ts";

export type Facing = "down" | "up" | "left" | "right";

// Lua: World.lua:76-98 -- SFX_* indices from audio/sfx_pointers.asm
// (constants.sfxOrder).
const SFX = {
  ITEM: 1,
  GET_TM: 0x9b,
  READ_TEXT_2: 8,
  SECOND_PART_OF_ITEMFINDER: 0x12,
  GAME_FREAK_LOGO_GS: 0xaa,
  BOOT_PC: 0x0d,
  SANDSTORM: 0x6d,
  STRENGTH: 27,
  PLACE_PUZZLE_PIECE_DOWN: 30,
  BUBBLEBEAM: 81,
  SURF: 83,
  FLASH: 169,
  ENTER_DOOR: 31,
  WARP_TO: 19,
  WARP_FROM: 20,
  KINESIS: 47,
  EXIT_BUILDING: 35,
  JUMP_OVER_LEDGE: 0x16,
  BUMP: 0x24,
  FLY: 0x18,
};
// Lua: World.lua:99
const EMOTE_SHOCK = 0;

// Lua: World.lua:104-107 -- movement direction -> map.connections key.
const DIR_CONN: Record<string, string> = { up: "north", down: "south", left: "west", right: "east" };
const FACING_ID: Record<string, number> = { down: 0, up: 1, left: 2, right: 3 };
const NEIGHBOR_HOPS = 2;

// Lua: World.lua:109-138
const VAR = {
  PARTYCOUNT: 0x01,
  BATTLERESULT: 0x02,
  BATTLETYPE: 0x03,
  TIMEOFDAY: 0x04,
  DEXCAUGHT: 0x05,
  DEXSEEN: 0x06,
  BADGES: 0x07,
  MOVEMENT: 0x08,
  FACING: 0x09,
  HOUR: 0x0a,
  WEEKDAY: 0x0b,
  MAPGROUP: 0x0c,
  MAPNUMBER: 0x0d,
  UNOWNCOUNT: 0x0e,
  ENVIRONMENT: 0x0f,
  BOXSPACE: 0x10,
  CONTESTMINUTES: 0x11,
  XCOORD: 0x12,
  YCOORD: 0x13,
  SPECIALPHONECALL: 0x14,
  // ../pokecrystal/constants/script_constants.asm:69-74, the six rows Gold's
  // table stops short of; ../pokecrystal/engine/overworld/variables.asm:62-67.
  BT_WIN_STREAK: 0x15,
  KURT_APRICORNS: 0x16,
  CALLERID: 0x17,
  BLUECARDBALANCE: 0x18,
  BUENASPASSWORD: 0x19,
  KENJI_BREAK: 0x1a,
};

// Lua: World.lua:140-147 -- constants/ram_constants.asm:293 wPlayerState.
// PLAYER_SKATE (2) has no row: nothing writes it, and FieldMoves has no
// string for it either.
const PLAYER_STATE_BY_ID: Record<number, string> = {
  0: FieldMoves.PLAYER_NORMAL,
  1: FieldMoves.PLAYER_BIKE,
  4: FieldMoves.PLAYER_SURF,
  8: FieldMoves.PLAYER_SURF_PIKA,
};

// Lua: World.lua:149-151 -- engine/overworld/variables.asm:49 VAR_MOVEMENT
// reads wPlayerState back.
const PLAYER_STATE_ID: Record<string, number> = {};
for (const id of Object.keys(PLAYER_STATE_BY_ID)) PLAYER_STATE_ID[PLAYER_STATE_BY_ID[Number(id)]!] = Number(id);

// Lua: World.lua:153-159
const BATTLETYPE = {
  CANLOSE: 1,
  // CheckEncounterRoamMon, ../pokecrystal/engine/overworld/wildmons.asm:561
  ROAMING: 5,
  FORCESHINY: 7,
  FORCEITEM: 10,
};

// Lua: World.lua:161-169 -- constants/collision_constants.asm, for GetWarpSFX.
const COLL = {
  DOOR: 0x71,
  WARP_PANEL: 0x7c,
  // CheckPitTile (home/map_objects.asm:162)
  // engine/overworld/events.asm:349-353
  PIT: 0x60,
  PIT_68: 0x68,
};

// Lua: World.lua:171
function isPitCollision(coll: unknown): boolean {
  return coll === COLL.PIT || coll === COLL.PIT_68;
}

// Lua: World.lua:175-179
const SPRITE = {
  VARS: 0xf0,
  DAY_CARE_MON_1: 0xe0,
  DAY_CARE_MON_2: 0xe1,
};

// Lua: World.lua:181-185
const ENGINE = {
  DAY_CARE_MAN_HAS_EGG: 5,
  DAY_CARE_MAN_HAS_MON: 6,
  DAY_CARE_LADY_HAS_MON: 7,
};

// Lua: World.lua:187-199
const MAPSETUP = {
  WARP: 0xf1,
  CONTINUE: 0xf2,
  RELOADMAP: 0xf3,
  TELEPORT: 0xf4,
  DOOR: 0xf5,
  FALL: 0xf6,
  CONNECTION: 0xf7,
  LINKRETURN: 0xf8,
  TRAIN: 0xf9,
  SUBMENU: 0xfa,
  BADWARP: 0xfb,
};

// Lua: World.lua:201-216
const MAPSETUP_FADE_OUT: Record<number, boolean> = {
  [MAPSETUP.DOOR]: true, [MAPSETUP.FALL]: true, [MAPSETUP.TELEPORT]: true,
};
// data/maps/setup_scripts.asm:27-32
const MAPSETUP_WARP_WINDOW: Record<number, boolean> = { [MAPSETUP.TELEPORT]: true };
const MAPSETUP_FADE_IN: Record<number, boolean> = {
  [MAPSETUP.DOOR]: true, [MAPSETUP.FALL]: true, [MAPSETUP.TELEPORT]: true,
  [MAPSETUP.WARP]: true, [MAPSETUP.BADWARP]: true, [MAPSETUP.TRAIN]: true,
  [MAPSETUP.LINKRETURN]: true, [MAPSETUP.CONTINUE]: true,
  [MAPSETUP.RELOADMAP]: true,
};
// MapSetupScript_Connection and _Submenu are the two with no FadeInFromWhite;
// naming them keeps the table above readable as the whole eleven-row set.
const MAPSETUP_NO_FADE: Record<number, boolean> = {
  [MAPSETUP.CONNECTION]: true, [MAPSETUP.SUBMENU]: true,
};

// Lua: World.lua:218-222 -- data/maps/setup_scripts.asm:48, :154, :175,
// :26-30; home/audio.asm:281, :335, :412
const MAPSETUP_MUSIC_BIKE: Record<number, boolean> = {
  [MAPSETUP.WARP]: true, [MAPSETUP.TELEPORT]: true,
  [MAPSETUP.CONTINUE]: true, [MAPSETUP.LINKRETURN]: true,
};

// Lua: World.lua:224-245 -- MapSetupCommands $26 UpdateRoamMons and $27
// JumpRoamMons. UpdateRoamMons is the tail of MapSetupScript_Train (and _Fall
// -> _Door -> _Train, and _Connection) and runs AFTER the load; JumpRoamMons
// is the third row of MapSetupScript_Teleport and runs BEFORE it. A plain
// MAPSETUP.WARP names neither.
const MAPSETUP_ROAM_UPDATE: Record<number, boolean> = {
  [MAPSETUP.CONNECTION]: true, [MAPSETUP.DOOR]: true,
  [MAPSETUP.FALL]: true, [MAPSETUP.TRAIN]: true,
};
const MAPSETUP_ROAM_JUMP: Record<number, boolean> = { [MAPSETUP.TELEPORT]: true };

// Lua: World.lua:247-258 -- FadeOutToWhite / FadeInFromWhite
// (engine/tilesets/timeofday_pals.asm): four steps, eight frames, per half.
const FADE_STEPS = 4;
const FADE_STEP_FRAMES = 2;
// data/maps/setup_scripts.asm:102-125, home/init.asm:149-153
const MAP_LOAD_WHITE_FRAMES = 13;
// data/maps/setup_scripts.asm:32-55
const WARP_LOAD_WHITE_FRAMES = 15;

// Lua: World.lua:260-269 -- home/map.asm:1927-1940 over home/tilemap.asm:12-25
const MENU_EXIT_RELOAD_FRAMES = 9;
const MENU_EXIT_WHITE_FRAMES = 4 + MENU_EXIT_RELOAD_FRAMES + (4 + 4) + 2;
// engine/pokegear/pokegear.asm:2074-2078, home/menu.asm:80-83
const FLY_EXIT_WHITE_FRAMES = 4 + 4 + MENU_EXIT_WHITE_FRAMES;
// engine/pokegear/pokegear.asm:2027-2046 over home/gfx.asm:189-262
const FLY_MAP_BUILD_FRAMES = 4 + 4 + 7 + 1 + 7 + 3 + 2;
// engine/events/overworld.asm:593-597, engine/menus/start_menu.asm:503-518
const FLY_CANCEL_BLANK_FRAMES = 4 + 8 + 4 + 5;
const FLY_CANCEL_ICON_FRAMES = 3;

// Lua: World.lua:271-279 -- a New Game starts in the bedroom: NewGame sets
// wDefaultSpawnpoint = SPAWN_HOME, PLAYERS_HOUSE_2F (3,3). landmarks carries
// the real table; these are the fallback.
const SPAWN_HOME = "SPAWN_HOME";
const START_MAP = "PLAYERS_HOUSE_2F";
const START_X = 3;
const START_Y = 3;
const START_FACING: Facing = "down";
const PLAYER_SPRITE = "SPRITE_CHRIS";

// Lua: World.lua:281-283 -- engine/overworld/player_object.asm:29-41
const PLAYER_PAL_MALE = { palette: 8 };
const PLAYER_PAL_FEMALE = { palette: 9 };

// Lua: World.lua:285-289 -- constants/event_flags.asm; HatchEggs sets this
// one by hand. wEventFlags is keyed by NUMBER here.
const EVENT_TOGEPI_HATCHED = 84;

// Lua: World.lua:291-295 -- the last flag InitializeEventsScript sets.
const EVENT_INITIALIZED_EVENTS = 54;

// Lua: World.lua:297-302 -- SPRITEMOVEDATA_STRENGTH_BOULDER, $19.
const SPRITEMOVEDATA_STRENGTH_BOULDER = 0x19;

// Lua: World.lua:304-306 -- Script_UsedStrength's `pause 3`.
const STRENGTH_PAUSE_FRAMES = 3;

// Lua: World.lua:308-341 -- field-move / field-item strings this file prints,
// in the port's TextBox markers (\n second line, \f page break, {STRBUF}
// wStringBuffer2). Transcribed: nothing in the script bytecode points at them.
const TEXT_ASK_HEADBUTT = Strings.source(
  "A POKéMON could be\nin this tree.\fWant to HEADBUTT\nit?");
const TEXT_USE_HEADBUTT = Strings.source("{STRBUF} did a\nHEADBUTT!");
const TEXT_HEADBUTT_NOTHING = Strings.source("Nope. Nothing…");
const TEXT_ROD_BITE = Strings.source("Oh!\nA bite!");
const TEXT_ROD_NOTHING = Strings.source("Not even a nibble!");
// _UseSweetScentText / _SweetScentNothingText (data/text/common_2.asm).
const TEXT_USE_SWEET_SCENT = Strings.source("{STRBUF} used\nSWEET SCENT!");
const TEXT_SWEET_SCENT_NOTHING =
  Strings.source("Looks like there's\nnothing here…");
// _UseSacredAshText (data/text/common_2.asm).
const TEXT_USE_SACRED_ASH = Strings.source(
  "{PLAYER}'s POKéMON\nwere all healed!");

// Lua: World.lua:343-349 -- CheckHeadbuttTreeTile: COLL_HEADBUTT_TREE and its
// unused $1d alias.
const HEADBUTT_TREE: Record<number, boolean> = { 0x15: true, 0x1d: true };

// Lua: World.lua:351-353 -- TryHeadbuttOW's CheckPartyMove.
const MOVE_HEADBUTT = "HEADBUTT";

// Lua: World.lua:355-360 -- the three fishing rods by items key.
const ROD_INDEX: Record<string, number> = { OLD_ROD: 0x3a, GOOD_ROD: 0x3b, SUPER_ROD: 0x3d };

// Lua: World.lua:362-366 -- RepelEffect / SuperRepelEffect / MaxRepelEffect.
const REPEL_STEPS: Record<string, number> = { REPEL: 100, SUPER_REPEL: 200, MAX_REPEL: 250 };

// Lua: World.lua:368-374 -- NormalBoxEffect / GorgeousBoxEffect: the item ->
// DECOFLAG_* it opens on (crossed on purpose, as the asm reads). Getters so
// the Decorations import is not read at module load.
const TROPHY_BOXES: Record<string, any> = {
  get NORMAL_BOX() { return Decorations.DECOFLAG_SILVER_TROPHY_DOLL; },
  get GORGEOUS_BOX() { return Decorations.DECOFLAG_GOLD_TROPHY_DOLL; },
};

// Lua: World.lua:376-381 -- frames at 60 Hz.
const FISH_CAST_FRAMES = 40;
const FISH_BITE_FRAMES = 40;
const HEADBUTT_SHAKE_FRAMES = 32;

// Lua: World.lua:383-400 -- the vanilla links the two encounter chains wrap.
function rollGrassVanilla(tables: any, ctx: any): any {
  return Encounter.grassSlot(tables, ctx.mapId, ctx.daytime, undefined);
}

function rollWaterVanilla(tables: any, ctx: any): any {
  return Encounter.waterSlot(tables, ctx.mapId, undefined);
}

function rollContestVanilla(_: any, ctx: any): any {
  return BugContest.chooseWild(ctx.data);
}

function sameEncounter(enc: any): any { return enc; }

// Lua: World.lua:402-415 -- the encounter.fishing chain's vanilla link.
const FISH_ROD_KEY: Record<string, string> = { OLD_ROD: "old", GOOD_ROD: "good", SUPER_ROD: "super" };

function fishVanilla(rod: any, _mapId: any, candidates: any, ctx: any): any {
  if (!truthy(candidates)) return undefined;
  const tod = ctx ? (ctx.tod ?? ctx.daytime) : undefined;
  return Encounter.fish({ fishGroups: { hooked: candidates },
                          timeFishGroups: ctx && ctx.encounters ? ctx.encounters.timeFishGroups : undefined },
    "hooked", FISH_ROD_KEY[rod] ?? rod ?? "old", tod, undefined);
}

// Lua: World.lua:417-423. Returns [id, def] (Lua's two results) or [].
function speciesByIndex(pokemon: any, index: any): [string, any] | [] {
  if (!pokemon || index == null) return [];
  for (const id of sortedKeys(pokemon)) {
    const def = pokemon[id];
    if (def !== null && typeof def === "object" && def.index === index) return [id, def];
  }
  return [];
}

// Lua: World.lua:425-431
function itemByIndex(items: any, index: any): [string, any] | [] {
  if (!items || index == null || index === 0) return [];
  for (const id of sortedKeys(items)) {
    const def = items[id];
    if (def !== null && typeof def === "object" && def.index === index) return [id, def];
  }
  return [];
}

// Lua: World.lua:433-438 -- one WRAM byte, the width every VAR_* store is.
function byteOf(value: unknown): number {
  let n = Math.floor(tonumber(value) ?? 0);
  if (n < 0) n = 0;
  return mod(n, 256);
}

// Lua: World.lua:440-449 -- CountSetBits over a { key = true } flag table.
function countFlags(flags: any): number {
  if (!flags) return 0;
  let n = 0;
  for (const k of Object.keys(flags)) {
    if (truthy(flags[k])) n = n + 1;
  }
  return n;
}

// Lua: World.lua:451-466 -- `givepoke` builds the same record a caught wild
// mon does, through battle/Mon.
function givePokeMon(data: any, speciesIndex: any, level: any, itemIndex: any, opts: any): any {
  const [id] = speciesByIndex(data.pokemon, speciesIndex);
  if (!id) return undefined;
  return Mon.new(data, id, level ?? 5, {
    item: itemIndex != null && itemIndex !== 0
      ? itemByIndex(data.items, itemIndex)[0] : undefined,
    nickname: opts ? opts.nickname : undefined,
  });
}

// Lua: World.lua:468-469 -- GivePoke's trainer arm
// (engine/pokemon/move_mon.asm:1698-1736)
const RANDY_OT_ID = 1001;

// Lua: World.lua:471-476 -- the generated tables come from platform/data.ts
// (the Lua's CacheFs.loadActive). Returns the table or undefined.
function loadGenerated(path: string): any {
  return loadGeneratedTable(path);
}

// Lua: World.lua:478-499 applyRoofOverlay pasted the roof sheet into a tile
// atlas image; the cook does that for the voxel world, so it is not here.

// ---- W1: World.lua:500-1959 locals ----------------------------------------

/** One placed neighbour from World.computeNeighbors: map id plus its pixel
 * offset from the root map's top-left. Lua: World.lua:536 */
export interface NeighborPlacement {
  id: string;
  ox: number;
  oy: number;
}

// Lua `type(v) == "table"`.
function isTable_W1(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object";
}

// `pcall(obj.name, obj)` over a LÖVE Source (World.lastSfx): [ok, result].
// A missing method is a failed pcall, exactly as calling nil would be.
function pcallMethod_W1(obj: any, name: string): [boolean, any] {
  try {
    if (obj == null || typeof obj[name] !== "function") return [false, undefined];
    return [true, obj[name]()];
  } catch (e) {
    return [false, e];
  }
}

// Lua: World.lua:1603-1605 -- wTimeOfDay (constants/ram_constants.asm):
// MORN_F 0, DAY_F 1, NITE_F 2, DARKNESS_F 3, off the RTC hour
// (engine/tilesets/timeofday_pals.asm:5-11).
const TIME_OF_DAY_ID: Record<string, number> = { MORN: 0, DAY: 1, NITE: 2, DARK: 3 };

// ---- W2: World.lua:1960-3556 module-level locals -------------------------

// Lua: World.lua:2329-2331 -- :1008-1021. StepFunction_Skyfall
// (engine/overworld/map_objects.asm:1368)
const SKYFALL_BEAT_FRAMES = 16;
const PITFALL_EARTHQUAKE = 0x10;

// Lua: World.lua:2447-2455 -- Script_warpsound -> GetWarpSFX (home/map.asm):
// which of three sounds a warp makes is decided by the tile the player is
// STANDING on, not by the destination. Looked up by name so a cache whose sfx
// table sits at other indices still finds them.
const WARP_SFX_NAME: Record<number, string> = {
  [SFX.ENTER_DOOR]: "Sfx_EnterDoor",
  [SFX.WARP_TO]: "Sfx_WarpTo",
  [SFX.EXIT_BUILDING]: "Sfx_ExitBuilding",
};

// Lua `a or b or c`: the first Lua-truthy value (0 and "" count), else the
// last. Ours, for the few `or` chains in W2 whose operands may be "".
function or_W2(...xs: unknown[]): any {
  for (const x of xs) if (truthy(x)) return x;
  return xs[xs.length - 1];
}

// The shape of an `onDone` resume a screen push hands back (Specials.block).
type OnDone_W2 = ((...a: any[]) => any) | undefined;

// ---------------------------------------------------------------------------
// W3: World.lua:3563-5212 -- fades and the map setup chain, the roamers, the
// specials hooks, movement streams, wild / contest / fishing encounters and
// the field items.
// ---------------------------------------------------------------------------

// The pokepic window is Gold-screen 2D UI: World:showPokePic keeps the cooked
// image Assets.image hands back (a tile grid with getDimensions), which the
// pokepic draw reads the way the Lua's draw read the LÖVE image.

/** self.fade: the colour a flat fade overlay ramps towards (nil = no fade). */
export type FadeColor = "white" | "black";

/**
 * self.mapSetup (Lua: World.lua:3619, :3626, :3639, :3686): the map setup
 * chain's fade state. `phase` "out" ramps to white over FADE_STEPS steps and
 * runs `load`; "in" holds white for `white` frames and ramps back.
 */
export interface MapSetupState {
  phase: "out" | "in";
  step: number;
  wait: number;
  load?: () => any;
  white?: number;
  /** set by the fly path (Lua: World.lua:6643): the mon FlyToAnim shows */
  flyIn?: any;
  /** set by World:runEscapeWarp: .UsedDigScript's return half */
  digIn?: boolean;
  /** set by the pit path (Lua: World.lua:10206): startSkyfall on arrival */
  fallIn?: boolean;
}

/** self.moveState (Lua: World.lua:4136): one applymovement stream. */
export interface MoveState {
  objectId: any;
  bytes: number[];
  /** 1-based cursor into `bytes`, as the Lua keeps it */
  i: number;
  sleep: number;
  onDone?: () => void;
  pendingStep?: Dir;
}

/** The FishFunction jumptable case World:rollFishing lands on. */
export type FishOutcome = "nowhere" | "nofish" | "nibble" | "battle";

// Lua: World.lua:4334-4339 -- engine/events/pokepic.asm:44-48
// PokepicMenuHeader `menu_coords 6, 4, 14, 13`, and PadFrontpic
// (engine/gfx/load_pics.asm:342) fitting 5x5/6x6 into the 7x7. `pad` is keyed
// by the pic's width in tiles; each pair is 0-based here ([x, y]).
const POKEPIC: { left: number; top: number; w: number; h: number; pad: Record<number, [number, number]> } = {
  left: 6, top: 4, w: 9, h: 10,
  pad: { 7: [0, 0], 6: [1, 1], 5: [1, 2] },
};

// Lua: World.lua:4449-4456 -- ApplyMusicEffectOnEncounterRate
// (engine/overworld/wildmons.asm:233-248): POKEMON MARCH and the RUINS OF ALPH
// station double the rate, POKEMON LULLABY halves it. It reads wMapMusic, so a
// radio station left playing counts.
const MUSIC_RATE: Record<string, "double" | "half"> = {
  Music_PokemonMarch: "double",
  Music_RuinsOfAlphRadio: "double",
  Music_PokemonLullaby: "half",
};

// Lua: World.lua:4692-4700 -- BugCatchingContestOverScript and
// BugCatchingContestOutOfBallsScript: the same two commands over a different
// line. Neither is a std script (they sit in
// engine/events/bug_contest/contest.asm, which nothing points at), so the
// text is authored here the way World:repelWoreOff's is.
const BUG_CONTEST_TIME_UP = Strings.source("ANNOUNCER: BEEEP!\fTime's up!");
const BUG_CONTEST_IS_OVER =
  Strings.source("ANNOUNCER: The\nContest is over!");
const SFX_ELEVATOR_END = 39;

// Lua: World.lua:4958-4971 -- _Squirtbottle (engine/events/squirtbottle.asm).
// The watered-tree body is sliced out of the extracted Sudowoodo talk script
// (maps/Route36.asm SudowoodoScript), whose .Fight arm falls through into the
// exported WateredWeirdTreeScript right after its yesorno's `iffalse` +
// `closetext` pair -- so the PACK use and the talk path run the very same
// decoded rows, battle and TWIN swap included.
const SPRITEMOVEDATA_SUDOWOODO = 0x17;
const TEXT_SQUIRTBOTTLE_NOTHING = Strings.source(
  "{PLAYER} sprinkled\nwater.\fBut nothing\nhappened…");

// ---- W4: World.lua:5213-6899 locals ----------------------------------------

// The fly icon keeps a SpriteHandle (Player.ts) where the Lua built a
// SpriteRenderer: the def (with its gfx key) and the OBJ palette handed to it.

/** self.fishing (Lua: World.lua:5363): Script_FishCastRod's frame counter. */
export interface FishingState {
  phase: "cast" | "bite" | "done";
  timer: number;
  outcome: any;
  wild: any;
  bobber: { cellX: number; cellY: number; px: number; py: number };
  facing: string;
}

/** One falling leaf of FlyFromAnim/FlyToAnim (Lua: World.lua:6533). Its
 * screen position is World.leafScreenPos(leaf). */
export interface FlyLeaf {
  x: number;
  y: number;
  wave: number;
  xoff: number;
}

/**
 * self.flyAnim (Lua: World.lua:6468-6477): the bird carrying the player off
 * (phase "from") or in (phase "to"). `icon` is the SpriteHandle of the mon's
 * party icon; World.birdScreenPos(fa) is where it sits on the 160x144 screen,
 * and drawFlyAnim's frame was floor(t / 8) % 4 (beat 3 mirrored, frame
 * beat % 2), drawn only once `preroll` has run out.
 */
export interface FlyAnimState {
  phase: "from" | "to";
  icon: SpriteHandle;
  onDone?: () => any;
  t: number;
  xoff: number;
  wave: number;
  leaves: FlyLeaf[];
  left: number;
  hover: number;
  amp: number;
  y: number;
  preroll: number;
}

// Lua `ipairs(t or {})` over a table that World.new starts as `{}` (a JS
// object) and later fills as a sequence: only a real array has entries.
function ipairs_W4(t: any): any[] {
  return Array.isArray(t) ? t : [];
}

// Lua: World.lua:5622-5628 -- readmem's engine seam. The VM keeps a sparse
// byte store for the addresses a script owns outright; these are the ones the
// ENGINE writes, where answering out of that store would read back a stale 0.
// RockSmashScript's `readmem wTempWildMonSpecies / iffalse` is the reason.
// wTempWildMonSpecies: 01:d117 (pokesilver.sym), 01:d22e (pokecrystal.sym)
const WRAM_TEMP_WILD_MON_SPECIES: Record<string, number> = { gs: 0xd117, crystal: 0xd22e };

// Lua: World.lua:5858-5860 safeRelease freed LÖVE GPU objects: nothing here
// owns one, so World:release only resets the tables (see there).

// Lua: World.lua:6025-6027 -- PlayerMovementPointers' .force_turn arm and the
// Script_ForcedMovement it calls -- events.asm:786-793,
// forced_movement.asm:1-51 (#1716)
const FORCED_BACK: Record<string, Facing> = { up: "down", down: "up", left: "right", right: "left" };

// Lua: World.lua:6246-6258 -- the block a cut or whirlpool result edits. The
// model works in block IDs because that is what field_move_blocks.asm is
// written in; the index (1-based, the cross-part block-index key) comes from
// the context that produced the result, so it is stapled on here.
function withBlockIndex(result: any, ctx: any): any {
  if (result && result.replacement != null) {
    result.blockIndex = ctx.facingBlockIndex;
  }
  if (result) {
    result.facingX = ctx.facingX;
    result.facingY = ctx.facingY;
  }
  return result;
}

// Lua: World.lua:6363-6365 -- ../pokecrystal/constants/landmark_constants.asm:34
const LANDMARK_PALLET_TOWN = 0x2e;
const LANDMARK_FAST_SHIP = 0x5e;

// Lua: World.lua:6400-6417 -- FlyFromAnim / FlyToAnim
// (engine/events/field_moves.asm:300, :334) and the two curves they run
// (engine/sprite_anims/functions.asm:1350, :1418). World.FLY_FROM_PREROLL
// (a W7 static) reads FROM_PREROLL.
const FLY = {
  FROM_FRAMES: 128, TO_FRAMES: 64, HOVER: 0x40,
  AMP_MAX: 0x40, TO_AMP: 11 * 8, RISE: 84,
  // engine/tilesets/timeofday_pals.asm:289-299, engine/events/field_moves.asm:305-311
  FROM_PREROLL: 2 + 4,
  // engine/events/field_moves.asm:341 (depixel 31, 10, 4, 0 up to 10 * 8 + 4)
  TO_RISE: 88,
  // engine/events/field_moves.asm:307 over data/sprite_anims/oam.asm:314
  BIRD_OX: 80 - 8 - 8, BIRD_OY: 84 - 8 - 16,
  // engine/sprite_anims/functions.asm:1389-1416
  LEAF_DEATH_X: 184, LEAF_AMP: 0x40,
  // constants/sprite_anim_constants.asm:20
  LEAF_MAX: 9,
  // data/sprite_anims/oam.asm:487 over the OAM origin
  LEAF_OX: -4 - 8, LEAF_OY: -4 - 16,
};

// ---------------------------------------------------------------------------
// W5: World.lua:6900-8683 -- battles from the overworld, the heal machine,
// the blocking specials (PC, mart, menus, trade, elevator, naming), the
// whiteout spawn, sound ids, coord / scene scripts, text boxes, object masks
// and the people list, bg events, trainers' sight and the A press.
// ---------------------------------------------------------------------------

// Lua `ipairs(t)` over a field World.new seeds as `{}` (npcs, neighbors,
// ghosts): an empty Lua table walks as an empty sequence, so a non-array here
// is the empty list rather than a TypeError.
function seq_W5<T = any>(t: unknown): T[] {
  return Array.isArray(t) ? (t as T[]) : [];
}

/** One heal-machine OBJ: [sx, sy] screen position (the cart's OAM minus its
 * 8/16 origin), and for balls a third `xflip` (OAM_XFLIP) flag. 0-based
 * arrays; `ha.lit` counts how many of `balls` (from index 0) are drawn. */
export type HealMachineTile = [number, number, boolean?];
export interface HealMachineLayout {
  machine?: HealMachineTile[];
  balls: HealMachineTile[];
}

/**
 * self.healAnim (Lua: World.lua:7406): HealMachineAnim's state, advanced by
 * World:stepHealAnim once a frame. The renderer draws it the way the Lua's
 * drawHealAnim did: every `layout.machine` tile ($7c) and the first `lit`
 * `layout.balls` ($7d, x-flipped where [2] is set) at world pixel
 * (px - 64 + sx, py - 64 + sy), under the heal-machine OBJ palette rotated
 * `rotation` slots (rBGP-shaped byte: sum of ((i + rotation) % 4) * 4^i).
 */
export interface HealAnimState {
  layout: HealMachineLayout;
  hof: boolean;
  balls: number;
  lit: number;
  timer: number;
  phase: "balls" | "flash";
  flashes: number;
  rotation: number;
  px: number;
  py: number;
  onDone?: () => void;
}

/** World:healPoint's answer (Lua: World.lua:7823, :7833, :7841). */
export interface HealPoint {
  map: string;
  x: number;
  y: number;
  spawn?: string;
}

// Lua: World.lua:7353-7391 -- HealMachineAnim (engine/events/
// heal_machine_anim.asm). .PC_ElmsLab_OAM / .HOF_OAM transcribed as screen
// positions (each dbsprite's raw OAM bytes minus the hardware's 8/16 OAM
// origin). The cart lays them out at fixed screen coordinates because the
// player is always standing on the machine's own talk cell, BG-aligned at
// (64,64) -- the same anchor Camera:follow keeps -- so each element's world
// position is the player's cell corner plus (sx - 64, sy - 64).
//
// `machine` is the two $7c tiles .PC_LoadBallsOntoMachine places before the
// party loop; `balls` fill one per party member in OAM order (top pair
// first), the right column OAM_XFLIPped. wScriptVar picks the table --
// HEALMACHINE_POKECENTER 0, HEALMACHINE_ELMS_LAB 1 (the same table shifted by
// `bcpixel 2, 4`), HEALMACHINE_HALL_OF_FAME 2 (all balls, fanning out from
// the machine's centre line).
const HEAL_MACHINE_LAYOUT: Record<number, HealMachineLayout> = {
  0: {
    machine: [[26, 16], [30, 16]],
    balls: [[24, 22], [32, 22, true], [24, 27], [32, 27, true],
      [24, 32], [32, 32, true]],
  },
  2: {
    balls: [[73, 44], [78, 44], [69, 43], [82, 43],
      [65, 41], [85, 41]],
  },
};
{
  const pc = HEAL_MACHINE_LAYOUT[0]!;
  const elm: HealMachineLayout = { machine: [], balls: [] };
  for (const t of pc.machine!) {
    elm.machine!.push([t[0] + 16, t[1] + 32]);
  }
  for (const b of pc.balls) {
    elm.balls.push([b[0] + 16, b[1] + 32, b[2]]);
  }
  HEAL_MACHINE_LAYOUT[1] = elm;
}

// Lua: World.lua:8039-8053 -- CheckObjectTime (home/map_objects.asm), the
// mask LoadObjectMasks computes beside CheckObjectFlag: an object_event's two
// hour bytes decide whether it is on the map AT ALL right now.
// macros/scripts/maps.asm spells the encoding out: h1 < h2 shows the object
// from h1 to h2 (inclusive both ends), h1 > h2 HIDES it strictly between h2
// and h1, h1 == h2 always shows, and h1 == -1 turns h2 into a MORN/DAY/NITE
// bitmask (-1 = always). This keeps the Goldenrod pharmacist single, empties
// the Mt Moon gift shop at night, and keeps exactly one of the three
// time-of-day Moms in the kitchen. The mask compares against the CLOCK's time
// of day (GetTimeOfDay reads hHours), never wTimeOfDayPalset -- which is why
// this reads World:hour and not World:timeOfDayId.
const MORN_MASK = 1, DAY_MASK = 2, NITE_MASK = 4;

// Lua: World.lua:8282-8303 -- CheckIfFacingTileCoordIsBGEvent (home/map.asm)
// matches on the COORDINATES alone and leaves the function byte to
// BGEventJumptable, ported past its first arm:
//   0 READ        a plain script pointer
//   1-4 UP/DOWN/RIGHT/LEFT  .checkdir -- read only when facing that way
//   5 IFSET       run the script only while the event IS set
//   6 IFNOTSET    run it only while the event is NOT set (TeamRocketBaseB3F's
//                 locked door to Giovanni's office is two of these)
//   7 ITEM        hidden item, handled by world/HiddenItems.ts
//   8 COPY        copies data without reading; nothing to run
// The cart's facing test is `and %1100`, i.e. the direction's top two bits, so
// it compares the FACING and not the button that produced it.
const BGEVENT_FACING: Record<number, string> = { 1: "up", 2: "down", 3: "right", 4: "left" };

// Lua: World.lua:8330-8352 -- engine/events/trainer_scripts.asm, as inline
// command lists: nothing in the ROM points at these two, so the extractor
// never sees them and the VM has to be handed the list. Kept
// command-for-command so the ordering (music before the seen text, flag set
// after the battle, after-script as a tail call) stays checkable.
const SEEN_BY_TRAINER_SCRIPT: Record<string, any>[] = [
  { op: "loadtemptrainer" },
  { op: "encountermusic" },
  // showemote EMOTE_SHOCK, LAST_TALKED, 30
  { op: "showemote", emote: 0, object: -2, frames: 30 },
  { op: "trainerapproach" },
  { op: "faceobject", a: 0, b: 1 },
  { op: "opentext" },
  { op: "trainertext", index: 0 }, // TRAINERTEXT_SEEN
  { op: "waitbutton" },
  { op: "closetext" },
  { op: "loadtemptrainer" },
  { op: "startbattle" },
  { op: "reloadmapafterbattle" },
  { op: "trainerflagaction", action: 1 }, // SET_FLAG
  { op: "scripttalkafter" },
];

// Lua: World.lua:8354-8371 -- TalkToTrainerScript: an already-beaten trainer
// skips straight to its after-battle script, which is why a beaten rival
// still has a line.
const TALK_TO_TRAINER_SCRIPT: Record<string, any>[] = [
  { op: "faceplayer" },
  { op: "trainerflagaction", action: 2 }, // CHECK_FLAG
  { op: "iftrue", script: [{ op: "scripttalkafter" }] },
  { op: "loadtemptrainer" },
  { op: "encountermusic" },
  { op: "opentext" },
  { op: "trainertext", index: 0 },
  { op: "waitbutton" },
  { op: "closetext" },
  { op: "loadtemptrainer" },
  { op: "startbattle" },
  { op: "reloadmapafterbattle" },
  { op: "trainerflagaction", action: 1 },
  { op: "scripttalkafter" },
];

// Lua: World.lua:8378-8381
function trainerKey(record: any): string | undefined {
  if (!(record && record.class != null && record.member != null)) return undefined;
  return tostring(record.class) + "/" + tostring(record.member);
}

// Lua: World.lua:8477-8491 -- TileCollisionStdScripts
// (data/collision/collision_stdscripts.asm), verbatim: collision byte -> the
// StdScripts label the extractor resolved into std_scripts. This is how every
// Pokecenter PC, house radio, town map poster and bookshelf in the game is
// read -- none of them is a bg event.
const TILE_COLLISION_STD_SCRIPTS: Record<number, string> = {
  0x91: "MagazineBookshelfScript", // COLL_BOOKSHELF
  0x93: "PCScript",                // COLL_PC
  0x94: "Radio1Script",            // COLL_RADIO
  0x95: "TownMapScript",           // COLL_TOWN_MAP
  0x96: "MerchandiseShelfScript",  // COLL_MART_SHELF
  0x97: "TVScript",                // COLL_TV
  0x9d: "WindowScript",            // COLL_WINDOW
  0x9f: "IncenseBurnerScript",     // COLL_INCENSE_BURNER
};

// Lua: World.lua:8493-8504 -- what the A press resolved to, for
// world.interacted's listeners. Same four payload keys as Gen 1 and the same
// `kind` vocabulary where the two engines share an arm: "npc", "sign",
// "hidden", "script", "none". Gold's own arms get their own words --
// "trainer", "boulder", "itemball", "std" and "fieldmove".
function interacted(self: World, fx: number, fy: number, kind: string, target?: any): void {
  if (!Runtime.wants("world.interacted")) return;
  Runtime.emit("world.interacted", {
    mapId: self.map ? self.map.id : undefined,
    x: fx, y: fy, kind,
    target,
  });
}
// ---------------------------------------------------------------------------
// W6: World.lua:8684-9813 and 11209-11825 -- the render-facing half: the map
// "images" (kept as cache keys and descriptors), tile animation clocks and
// cell lists, palette / time-of-day selection, the neighbour strips, input
// polling, and World:viewState() (NEW: what platform/worldview.ts draws).
// ---------------------------------------------------------------------------

// GbcPalette's COLOR mode is part of every map cache key (World:mapCacheKey)
// and of World:refreshColorMode; G is the Gold screen the pokepic window and
// the map name sign draw on (World:drawOverlay).

// heldDirection: defined in W7.locals.ts

// Lua: World.lua:8693-8697 -- home/map.asm:1739 LoadTilesetGFX
const ROOF_TILESETS: Record<string, boolean> = {
  TILESET_JOHTO: true,
  TILESET_JOHTO_MODERN: true,
};

/**
 * World:atlasFor's result (Lua: World.lua:8699). The Lua built the tileset
 * atlas image (with the map group's roof pasted in); the cook does the roof
 * for the voxel world, so this keeps the identity: the cache key and the gfx
 * keys it was made from.
 */
export interface TileAtlasRef {
  /** tileset id, plus "|<roof>" for a roofed Johto tileset */
  key: string;
  /** the tileset's gfx key (tilesets.json image) */
  image: string;
  /** the roof sheet's gfx key when one applies */
  roofImage?: string;
  tilesPerRow: number;
}

/**
 * What World:imageFor / bakeMapImage hand back in place of the baked map
 * canvas (Lua: World.lua:8741, :8945). Callers only store it (self.mapImage,
 * nb.image) and test it for truthiness; the renderer reads the key.
 */
export interface MapImageRef {
  mapId: string;
  /** World:mapCacheKey at bake time: map|daytime|COLOR mode|ramp|flicker */
  key: string;
  daytime: string | undefined;
  /** cave-entrance flicker phase baked in (1 unless DARK) */
  flicker: number;
  tileset: string;
  atlas: string;
}

/** One tile's frame source, from World:animLayers (Lua: World.lua:8860). */
export interface AnimLayer {
  kind: "water" | "flower" | "whirlpool" | "tower" | "lava1" | "lava2" | "scroll";
  /** frame strip gfx key (absent for "scroll") */
  sheet?: string;
  frames?: number;
  /** WriteTileFromAnimBuffer's scroll rule: { h, v } */
  scroll?: { h?: number; v?: number };
}

/**
 * Every cell of one tile id a tileset's anim program repaints on one map
 * (Lua: World.lua:8895). `cells` is flat map-pixel pairs x0, y0, x1, y1, ...
 * of 8x8 tiles; `slot` is the PalMap slot (1-based, as bgSet is indexed by
 * the Lua).
 */
export interface AnimCellList {
  layer: AnimLayer;
  tile: number;
  slot: number;
  cells: number[];
}

/** World:borderWaterFrame (Lua: World.lua:9370). `row` is 1-based. */
export interface BorderWaterFrame {
  image: string;
  row: number;
  tile: number;
  slot: number;
}

/** World:borderImageFor's descriptor in place of the 32x32 border bake. */
export interface BorderImageRef {
  key: string;
  mapId: string;
  blockId: number;
  atlas: string;
  bgSet: any;
  waterFrame: BorderWaterFrame | undefined;
}

// Lua: World.lua:8847-8854 -- the functions whose frame strip the extractor
// already resolved, keyed to the rule World:animRow reads them back with.
const ANIM_KINDS: Record<string, AnimLayer["kind"]> = {
  AnimateWhirlpoolTile: "whirlpool",
  AnimateTowerPillarTile: "tower",
  AnimateLavaBubbleTile1: "lava1",
  AnimateLavaBubbleTile2: "lava2",
};

// Lua: World.lua:9049-9068 playfieldOrigin / intersectScissor: scissor
// helpers for the BG-over-OBJ blits, drawing, replaced by viewState().

// Lua: World.lua:9497-9499 -- AnimateTowerPillarTile's own offsets table
// (tileset_anims.asm:334-342): five frames walked up and back down over the
// 0..7 timer. Indexed by the timer (0-based); the VALUES stay the Lua's
// 1-based strip rows.
const TOWER_ROWS: number[] = [1, 2, 3, 4, 5, 4, 3, 2];

// Lua: World.lua:9548-9551 -- ScrollTileRightLeft (tileset_anims.asm:65)
// scrolls right for four ticks then left for four: the offset the buffer has
// reached at each value of the 0..7 timer (indexed by the timer).
const SCROLL_H: number[] = [0, 1, 2, 3, 2, 1, 0, -1];

/**
 * Lua: World.lua:9581-9583 (inside World:scrollStrip's bake) -- where one
 * scroll tile's 8x8 picture is rotated to at timer value `timer` (0..7):
 * [dx, dy], each 0..7, the tile wrapping around. The Lua baked the eight
 * rotations into a strip; the renderer applies this instead.
 */
export function scrollTileOffset(timer: number, scroll: { h?: number; v?: number }): [number, number] {
  const t = mod(timer, 8);
  const dx = (scroll.h ?? 0) > 0 ? mod(SCROLL_H[t]!, 8) : 0;
  const dy = mod(t * (scroll.v ?? 0), 8);
  return [dx, dy];
}

// Lua: World.lua:9702-9706 -- the two vanilla links the time-of-day chains
// wrap, hoisted so an empty chain allocates no closure.
function sameTod(tod: any): any { return tod; }
function samePalette(name: any): any { return name; }

// ---------------------------------------------------------------------------
// WorldView: what World:viewState() returns (documented field by field above
// the method in W6.members.ts).
// ---------------------------------------------------------------------------

/** A sprite-sheet tile placed at a map pixel (8x8 unless noted). */
export interface PlacedTile {
  x: number;
  y: number;
  /** OAM_XFLIP: the tile is drawn mirrored */
  flip: boolean;
}

export interface WorldMapView {
  id: string;
  /** landmark name (World:landmarkName), for a renderer's own caption */
  name: string | undefined;
  group: number | undefined;
  number: number | undefined;
  tileset: string | undefined;
  environment: string | undefined;
  /** map header PALETTE_* */
  palette: string | undefined;
  /** size in 32px blocks */
  width: number;
  height: number;
  borderBlock: number;
  /** self.mapImage (MapImageRef) */
  image: MapImageRef | undefined;
  /** the resolved BG palette set the bake used (Lua bgSets[key]; slots 1-8 at [0..7]) */
  bgSet: any;
  /** this frame's animated tiles on this map (animCells[key] with rows) */
  anim: WorldAnimCells[] | undefined;
}

export interface WorldAnimCells extends AnimCellList {
  /** strip row to show this frame (World:animRow, 1-based) */
  row: number;
  /** scroll layers: this frame's [dx, dy] rotation (scrollTileOffset) */
  scrollOffset?: [number, number];
}

export interface WorldNeighborView {
  id: string;
  /** pixel offset of the neighbour's top-left from the current map's */
  ox: number;
  oy: number;
  image: MapImageRef | undefined;
  bgSet: any;
  anim: WorldAnimCells[] | undefined;
}

export interface WorldBorderView {
  /** BorderFill.fillBlock: the metatile the void shows, or false = flat black */
  fillBlock: number | false;
  /** BorderFill.fillKey: crossfade identity */
  fillKey: string;
  image: BorderImageRef | undefined;
  /** BorderFill.crossfade: the previous border image dissolving out, if any */
  crossfadeFrom: unknown;
  /** alpha of `image` over crossfadeFrom (1 = settled) */
  crossfadeAlpha: number;
}

export interface GrassShakeView {
  /** emotes.grassRustle gfx key */
  gfx: string | undefined;
  /** OW palette id (PAL_OW_* 6) */
  paletteId: number;
  tiles: [PlacedTile, PlacedTile];
}

export interface JumpShadowView {
  /** emotes.jumpShadow gfx key */
  gfx: string | undefined;
  paletteId: number;
  tiles: [PlacedTile, PlacedTile];
}

export interface WorldActorEntry {
  kind: "player" | "npc";
  /** Player:viewState() / NPC:viewState(); px/py are local to the actor's map */
  view: ActorView;
  /** the actor's map's offset from the current map (0,0 unless a ghost) */
  ox: number;
  oy: number;
  /** false for a neighbour-strip ghost */
  onMap: boolean;
  mapId: string | undefined;
  /** index into world.npcs (on-map NPC), else -1 */
  npcIndex: number;
  /** the tall-grass redraw over the feet (inGrass and not shaking) -- on-map only */
  grassOver: boolean;
  grassShake?: GrassShakeView;
  jumpShadow?: JumpShadowView;
}

export interface EmoteView {
  gfx: string;
  /** emoteOrder key of the bubble when it can be named */
  name: string | undefined;
  target: "player" | "npc";
  npcIndex: number;
  /** map pixels (current map) of the 16x16 bubble's top-left */
  x: number;
  y: number;
  framesLeft: number;
  paletteId: number;
}

export interface HealMachineView {
  gfx: string | undefined;
  palette: any;
  hof: boolean;
  phase: string;
  /** the $7c light tiles, map pixels */
  lights: PlacedTile[];
  /** the $7d balls placed so far, map pixels */
  balls: PlacedTile[];
  /** FlashPalettes' colour rotation 0..3 and the rBGP-shaped remap byte */
  rotation: number;
  remapByte: number;
}

export interface FlyAnimView {
  phase: "from" | "to";
  /** frames of the palette preroll left: nothing is drawn while > 0 */
  preroll: number;
  /** the mon icon (flyIconFor's handle) */
  icon: any;
  /** GB-SCREEN pixels (0..160 x 0..144, plus gbScreenOrigin), or undefined off screen */
  bird: { x: number; y: number; beat: number; frame: number; mirror: boolean } | undefined;
  /** cut-grass leaf tiles, GB-SCREEN pixels, on-screen ones only */
  leaves: { x: number; y: number }[];
  leafGfx: string | undefined;
  leafPaletteId: number;
}

export interface FadeView {
  color: "white" | "black";
  /** 0..1 fade level (the setup chain's four-step ramp; 1 for a fade special) */
  level: number;
  /** frames of held white left (mapSetup), when set */
  hold: number | undefined;
  whiten: boolean;
  /** "remap": palette ramp (timeofday_pals.asm:65-91) with row/byte; "sheet": flat colour at `level` alpha */
  mode: "remap" | "sheet";
  row: number[] | undefined;
  byte: number | undefined;
}

export interface WorldView {
  /** false before a map/player exists: the Lua drew the "No map." title card */
  ready: boolean;
  status: string | undefined;
  isCrystal: boolean;
  map: WorldMapView | undefined;
  neighbors: WorldNeighborView[];
  border: WorldBorderView | undefined;
  camera: { x: number; y: number; viewW: number; viewH: number };
  shakeY: number;
  player: {
    view: ActorView;
    visible: boolean;
    moving: boolean;
    jumping: boolean;
    state: string | undefined;
    stateId: number | undefined;
    inGrass: boolean;
  } | undefined;
  actors: WorldActorEntry[];
  peopleHidden: boolean;
  hideAll: boolean;
  hidePlayer: boolean;
  playerMasked: boolean;
  playerHidden: boolean;
  skyfall: { phase: string; timer: number; height: number } | undefined;
  emote: EmoteView | undefined;
  fishing: { phase: string; timer: number; facing: string; bobber: { cellX: number; cellY: number; px: number; py: number } } | undefined;
  headbutt: { x: number; y: number; timer: number } | undefined;
  heal: HealMachineView | undefined;
  fly: FlyAnimView | undefined;
  flyHidden: string | undefined;
  fieldMove: string | undefined;
  fade: FadeView | undefined;
  poisonFlash: { rgba: [number, number, number, number] } | undefined;
  palette: {
    daytime: string | undefined;
    tod: string | undefined;
    timeOfDayId: number | undefined;
    colorMode: string;
    flashUsed: boolean;
    dark: boolean;
    flickerPhase: number;
    flickerClock: number;
  };
  tileAnim: { clock: number; timer: number };
  mapSign: { shown: boolean; timer: number; name: string } | undefined;
  ui: {
    textbox: boolean;
    choicebox: boolean;
    pokePic: boolean;
    script: boolean;
    moveState: boolean;
    mapSetup: boolean;
    busy: boolean;
    battleActive: boolean;
  };
}

// ---------------------------------------------------------------------------
// viewState() helpers (W6): each gathers what one Lua draw function read.
// ---------------------------------------------------------------------------

// Lua `ipairs(t)` over a field that may still be World.new's empty table.
function seq_W6(t: any): any[] {
  return Array.isArray(t) ? t : [];
}

// Lua: World.lua:9616-9668 drawAnimCells -- the cell lists of one map bake
// (animCells[key]) with the strip row each shows this frame.
function animView_W6(self: World, key: string): WorldAnimCells[] | undefined {
  const cells = self.animCells ? self.animCells[key] : undefined;
  if (!truthy(cells)) return undefined;
  const out: WorldAnimCells[] = [];
  for (const k of Object.keys(cells)) {
    const list: AnimCellList = cells[k];
    const entry: WorldAnimCells = { ...list, row: self.animRow(list.layer) };
    if (list.layer.kind === "scroll" && list.layer.scroll) {
      entry.scrollOffset = scrollTileOffset(self.animTimer ?? 0, list.layer.scroll);
    }
    out.push(entry);
  }
  return out;
}

// Lua: World.lua:11311-11381 drawPeople (with drawEntityComposite,
// drawGrassOver, drawGrassShake :9313-9342 and drawJumpShadow :9345-9366):
// the Y-sorted draw list and, per entry, the effects drawn with it.
export function peopleView_W6(self: World, out: WorldActorEntry[], hideAll: boolean,
                       hidePlayer: boolean, crystal: boolean): void {
  if (hideAll) return;
  const p = self.player;
  // ../pokecrystal/engine/overworld/map_objects.asm:2191-2205
  const filter = self.spriteFilter;
  const passes = (npc: any): boolean => !filter || truthy(filter(npc));
  const list: { kind: "player" | "npc"; entity: any; ox: number; oy: number; py: number;
    npcIndex: number }[] = [];
  if (!hidePlayer && !truthy(self.playerMasked) && !truthy(self.playerHidden)) {
    list.push({ kind: "player", entity: p, ox: 0, oy: 0, py: p.py, npcIndex: -1 });
  }
  seq_W6(self.npcs).forEach((npc: any, i: number) => {
    if (passes(npc) && !truthy(npc.hiddenByMovement)) {
      list.push({ kind: "npc", entity: npc, ox: 0, oy: 0, py: npc.py, npcIndex: i });
    }
  });
  for (const g of seq_W6(self.ghosts)) {
    if (passes(g.npc)) {
      list.push({ kind: "npc", entity: g.npc, ox: g.ox, oy: g.oy, py: g.oy + g.npc.py, npcIndex: -1 });
    }
  }
  list.sort((a, b) => a.py - b.py);

  for (const entry of list) {
    const entity = entry.entity;
    const onMap = entry.ox === 0 && entry.oy === 0;
    const grassCond = truthy(entity.inGrass)
      && !(truthy(entity.grassShake) && truthy(entity.moving));
    const item: WorldActorEntry = {
      kind: entry.kind,
      view: entity.viewState(),
      ox: entry.ox,
      oy: entry.oy,
      onMap,
      mapId: entry.kind === "player" ? (self.map ? self.map.id : undefined) : entity.mapId,
      npcIndex: entry.npcIndex,
      // Crystal's drawEntityComposite splits every entry's OAM round the
      // grass; Gold/Silver redraw it on the current map's entries only.
      grassOver: crystal ? grassCond : (onMap && grassCond),
    };
    // drawJumpShadow (map_objects.asm:1995, :879-893, facings.asm:161-164),
    // drawn for every entry.
    if (truthy(self.jumpShadowImage) && truthy(entity.jumping)) {
      const facing = entity.facing;
      const dy = (facing === "left" || facing === "right") ? 8 : 10;
      const x = entry.ox + entity.px;
      const y = entry.oy + entity.py + dy;
      item.jumpShadow = {
        gfx: self.jumpShadowImage, paletteId: 5,
        tiles: [{ x, y, flip: false }, { x: x + 8, y, flip: true }],
      };
    }
    // drawGrassShake (ShakeGrass' object, map_objects.asm:2031): FacingGrass1
    // at (0,+8)/(+8,+8), FacingGrass2 at (-1,+9)/(+9,+9), alternating every
    // four frames; MovementFunction_ShakingGrass dies a frame before the step
    // lands (:965). The second entry is OAM_XFLIPped. On-map entries only.
    if (onMap && truthy(self.grassRustleImage) && truthy(entity.grassShake)
        && truthy(entity.moving)) {
      const frames = entity.stepFrames ?? Player.STEP_FRAMES;
      const progress = entity.progress ?? 0;
      if (progress < frames) {
        let x1 = 0;
        let x2 = 8;
        let dy = 4;
        if (mod(progress, 8) >= 4) { x1 = -1; x2 = 9; dy = 5; }
        const y = entity.py + dy;
        item.grassShake = {
          gfx: self.grassRustleImage, paletteId: 6,
          tiles: [{ x: entity.px + x1, y, flip: false }, { x: entity.px + x2, y, flip: true }],
        };
      }
    }
    out.push(item);
  }
}

// Lua: World.lua:11390-11429 drawEmote -- SpawnEmote.EmoteObject
// (map_objects.asm:2029): the bubble one cell above the object, on
// PAL_OW_EMOTE (paletteId 5 through the daytime lookup).
function emoteView_W6(self: World): EmoteView | undefined {
  const e = self.emote;
  if (!(e && truthy(e.image))) return undefined;
  const ent = e.entity;
  let name: string | undefined = undefined;
  for (const key of seq_W6(self.emoteOrder)) {
    if (self.emoteImages && self.emoteImages[key] === e.image) { name = key; break; }
  }
  return {
    gfx: e.image,
    name,
    target: ent === self.player ? "player" : "npc",
    npcIndex: seq_W6(self.npcs).indexOf(ent),
    x: ent.px,
    y: ent.py - 16,
    framesLeft: e.left,
    paletteId: 5,
  };
}

// Lua: World.lua:7471-7519 drawHealAnim -- HealMachineAnim's OBJs at the
// player's cell corner plus (sx - 64, sy - 64); the flash is the palette
// rotation as an rBGP-shaped byte (GbcPalette.remap).
function healView_W6(self: World): HealMachineView | undefined {
  const ha = self.healAnim;
  const img = self.healMachineImage;
  if (!(ha && truthy(img))) return undefined;
  const ox = ha.px - 64;
  const oy = ha.py - 64;
  const lights: PlacedTile[] = [];
  for (const t of seq_W6(ha.layout.machine)) lights.push({ x: ox + t[0], y: oy + t[1], flip: false });
  const balls: PlacedTile[] = [];
  for (let i = 0; i < ha.lit; i++) {
    const b = ha.layout.balls[i];
    if (b) balls.push({ x: ox + b[0], y: oy + b[1], flip: truthy(b[2]) });
  }
  let byte = 0;
  for (let i = 0; i <= 3; i++) byte = byte + ((i + ha.rotation) % 4) * (4 ** i);
  return {
    gfx: img, palette: self.healMachinePalette, hof: truthy(ha.hof), phase: ha.phase,
    lights, balls, rotation: ha.rotation, remapByte: byte,
  };
}

// Lua: World.lua:6560-6624 drawFlyLeaves / drawFlyAnim -- the bird icon
// (.Frameset_RedWalk: two 8-frame beats, the fourth mirrored) and the
// cut-grass leaves, in GB-screen pixels plus World:gbScreenOrigin (0 at
// 160x144). Nothing shows during the preroll.
function flyView_W6(self: World): FlyAnimView | undefined {
  const fa = self.flyAnim;
  if (!(fa && fa.icon)) return undefined;
  const preroll = fa.preroll ?? 0;
  let bird: FlyAnimView["bird"] = undefined;
  const leaves: { x: number; y: number }[] = [];
  if (preroll <= 0) {
    const [sox, soy]: [number, number] = self.gbScreenOrigin();
    const [bx, by] = World.birdScreenPos(fa);
    if (!World.offGbScreen(bx, by, 16, 16)) {
      const beat = Math.floor(fa.t / 8) % 4;
      bird = { x: bx + sox, y: by + soy, beat, frame: beat % 2, mirror: beat === 3 };
    }
    if (fa.leaves && truthy(self.cutGrassImage)) {
      for (const leaf of seq_W6(fa.leaves)) {
        const [lx, ly] = World.leafScreenPos(leaf);
        if (!World.offGbScreen(lx, ly, 8, 8)) leaves.push({ x: lx + sox, y: ly + soy });
      }
    }
  }
  return {
    phase: fa.phase, preroll, icon: fa.icon, bird, leaves,
    leafGfx: self.cutGrassImage, leafPaletteId: 6,
  };
}

// Lua: World.lua:11716-11720 + :11581-11589 drawFadeRemap + :11778-11795 --
// with the setup chain's ramp running (a fade and no white hold), the fade
// is a BGP remap of the whole world (timeofday_pals.asm:65-91); otherwise
// (held white, or no map palettes to remap) a flat sheet at fadeLevel.
function fadeView_W6(self: World): FadeView | undefined {
  if (!truthy(self.fade)) return undefined;
  const row: number[] | undefined = World.fadeRampRow(self.fade, self.fadeLevel);
  const remap = self.fadeHold == null && !!row
    && truthy(self.map) && truthy(self.map.def) && truthy(self.palettes);
  return {
    color: self.fade,
    level: self.fadeLevel ?? 1,
    hold: self.fadeHold ?? undefined,
    whiten: truthy(self.fadeWhiten),
    mode: remap ? "remap" : "sheet",
    row,
    byte: row ? World.fadeRampByte(row) : undefined,
  };
}

// ---- W7: World.lua:9814-11208 locals ----------------------------------------

/**
 * What heldDirection reads off the Game's input (Game2's `self.input`, an
 * shared/core/Input.ts instance): only `isDown(btn)` for the four d-pad
 * names, tested in the order up, down, left, right. Lua: World.lua:10046
 */
export interface DirectionInput {
  isDown(btn: "up" | "down" | "left" | "right"): unknown;
}

// Lua: World.lua:10046-10059. The first held direction in up/down/left/right
// order. The Lua's no-input arm polled love.keyboard (arrows / WASD); there
// is no keyboard here, so with no input object nothing is held. World:pollInput
// (the next range) is the caller.
function heldDirection(input: DirectionInput | undefined | null): Facing | undefined {
  if (input) {
    if (truthy(input.isDown("up"))) return "up";
    if (truthy(input.isDown("down"))) return "down";
    if (truthy(input.isDown("left"))) return "left";
    if (truthy(input.isDown("right"))) return "right";
    return undefined;
  }
  // Lua: World.lua:10054-10057 love.keyboard.isDown fallback: dropped.
  return undefined;
}

// Lua: World.lua:10112-10118 -- EnterMapWarp's .SaveDigWarp (home/map.asm):
// CheckOutdoorMap (ROUTE, TOWN) into CheckIndoorMap (INDOOR, CAVE, DUNGEON,
// GATE), minus the routine's own two outdoor-inside-indoor exceptions.
const DIG_WARP_OUTDOOR: Record<string, boolean> = { ROUTE: true, TOWN: true };
const DIG_WARP_INDOOR: Record<string, boolean> = {
  INDOOR: true, CAVE: true, DUNGEON: true, GATE: true,
};
const DIG_WARP_EXCLUDED: Record<string, boolean> = {
  MOUNT_MOON_SQUARE: true, TIN_TOWER_ROOF: true,
};

// Lua: World.lua:10146-10149 -- the warp.destination chain's vanilla link:
// the resolved destination passes through, as a [mapId, x, y] tuple (Lua's
// three returns). The ctx argument is ignored, as in the Lua.
function warped(mapId: any, x: any, y: any, _ctx?: any): [any, any, any] {
  return [mapId, x, y];
}

/** The two map questions Player:tryMove asks (see Player.ts verdict()). */
interface StepMap_W7 {
  inBounds(x: number, y: number): boolean;
  isWalkable(x: number, y: number): boolean;
}

// Lua: World.lua:10333-10342 -- a map proxy that refuses every step but keeps
// bounds honest. Handed to tryMove when GetMovementPermissions forbids the
// direction: the press still has to TURN the player (the cart's .bump path
// runs after the facing is written), so the refusal cannot short-circuit
// above tryMove.
function refusingMap(map: any): StepMap_W7 {
  return {
    inBounds: (x: number, y: number) => map.inBounds(x, y),
    isWalkable: () => false,
  };
}

// Lua: World.lua:10344-10346 -- the movement.speed chain's vanilla link,
// hoisted so an empty chain allocates no closure on a per-step path.
function sameFrames(frames: any, _ctx?: any): any { return frames; }

// Lua: World.lua:10655-10658
function monName(mon: any): string {
  if (mon === null || typeof mon !== "object") return "?";
  return mon.nickname ?? mon.name ?? mon.species ?? "?";
}

// Lua: World.lua:10934-10937 -- once a second, ask whether the clock rolled
// into a new time of day (UpdateTimePals' cadence).
const PALETTE_POLL_STEPS = 60;

// Lua: World.lua:101-102
export class World {
  // World.new builds a table of ~80 fields and the rest of the file adds
  // more as it goes (self.mapSetup, self.fishing, ...), exactly as the Lua
  // does; they are open-ended here for the same reason.
  [key: string]: any;
  static [key: string]: any;
  // ---- W1: World.lua:500-1959 ---------------------------------------------

  // Lua: World.lua:501-550
  // Gen 2 connections use mapId (name); offsets are in blocks (32 px), same
  // strip math as Gen 1 OverworldState.computeNeighbors. pairs() over a map's
  // connections is walked in sortedKeys order so the placement is stable.
  static computeNeighbors(maps: any, rootId: string, hops: number,
                          reachW?: number, reachH?: number): NeighborPlacement[] {
    const out: NeighborPlacement[] = [];
    const rootDef = maps[rootId];
    if (!truthy(rootDef)) return out;
    const placed: Record<string, boolean> = { [rootId]: true };
    const queue: { def: any; ox: number; oy: number; hops: number }[] =
      [{ def: rootDef, ox: 0, oy: 0, hops: 0 }];
    let qi = 0;
    const inReach = (def: any, ox: number, oy: number): boolean => {
      if (!(reachW != null && reachH != null && truthy(rootDef))) return false;
      return ox + def.width * 32 > -reachW
        && ox < rootDef.width * 32 + reachW
        && oy + def.height * 32 > -reachH
        && oy < rootDef.height * 32 + reachH;
    };
    while (queue[qi]) {
      const cur = queue[qi]!;
      qi = qi + 1;
      const conns = cur.def.connections ?? {};
      for (const dir of sortedKeys(conns)) {
        const conn = conns[dir];
        const destId = conn.mapId ?? conn.map;
        const destDef = typeof destId === "string" ? maps[destId] : undefined;
        if (truthy(destDef) && !placed[destId]) {
          placed[destId] = true;
          let offset = conn.offset ?? 0;
          if (offset === 0) offset = 0; // squash signed-zero
          let ox: number, oy: number;
          if (dir === "north") {
            ox = offset * 32; oy = -destDef.height * 32;
          } else if (dir === "south") {
            ox = offset * 32; oy = cur.def.height * 32;
          } else if (dir === "west") {
            ox = -destDef.width * 32; oy = offset * 32;
          } else {
            ox = cur.def.width * 32; oy = offset * 32;
          }
          ox = cur.ox + ox;
          oy = cur.oy + oy;
          if (cur.hops + 1 <= hops || inReach(destDef, ox, oy)) {
            out.push({ id: destId, ox, oy });
            if (cur.hops + 1 < hops || inReach(destDef, ox, oy)) {
              queue.push({ def: destDef, ox, oy, hops: cur.hops + 1 });
            }
          }
        }
      }
    }
    return out;
  }

  // Lua: World.lua:552-677
  static new(game: any): World {
    const self = new World();
    Object.assign(self, {
      game,
      status: undefined,
      maps: undefined,
      tilesets: undefined,
      roofs: undefined,
      sprites: undefined,
      scripts: undefined,
      text: undefined,
      constants: undefined,
      events: Events.new(),
      mapScenes: {}, // [mapId] = sceneId
      // wCmdQueue: four slots, refilled from the map's MAPCALLBACK_CMDQUEUE on
      // every load and polled once a frame (engine/overworld/cmd_queue.asm).
      cmdQueue: CmdQueue.new(),
      vm: undefined,
      map: undefined,
      player: undefined,
      mapImage: undefined,
      mapImages: {},
      // _AnimateTileset's two counters (engine/tilesets/tileset_anims.asm:11,
      // :57), plus the per-bake cell lists and palettes the frames draw with.
      animClock: 0,
      animTimer: 0,
      animCells: {},
      bgSets: {},
      neighbors: [],
      atlasCache: {},
      npcPool: {},
      npcs: [],
      ghosts: [],
      entities: [],
      talkNpc: undefined,
      camera: Camera.new(),
      heldDir: undefined,
      // wPlayerTurningDirection's useful half: the direction a STEP latched via
      // .FinishFacing. CheckStandingOnIce + .CheckForced re-inject it as the
      // d-pad while the tile underfoot is COLL_ICE, which is the whole
      // ice-slide rule (engine/overworld/player_movement.asm). Nil = standing.
      turningDirection: undefined,
      viewW: 160,
      viewH: 144,
      moveState: undefined,
      lastSfx: undefined,
      pokePic: undefined,
      pendingSceneScript: false,
      startedOverworld: false,
      // GBC color state (engine/gfx/color.asm). `daytime` is the resolved
      // MORN/DAY/NITE/DARK the map is lit by; clockHour overrides World:hour
      // for drivers and tests, so the palette, the hour windows and VAR.HOUR
      // all move together; flashUsed lifts PALETTE_DARK maps.
      palettes: undefined,
      daytime: undefined,
      clockHour: undefined,
      // wCurDay, SUNDAY 0 .. SATURDAY 6, when something wants to pin it; nil
      // reads the host clock. See World:weekday.
      clockDay: undefined,
      flashUsed: false,
      paletteClock: 0,
      // FlickeringCaveEntrancePalette's frame counter: only a DARKNESS_PALSET
      // map reads it, to decide which of two baked canvases is up.
      flickerClock: 0,
      flickerPhase: 1,
      // wPlayerState (constants/ram_constants.asm), as FieldMoves names it.
      playerState: FieldMoves.PLAYER_NORMAL,
      // BIKEFLAGS_STRENGTH_ACTIVE_F. ResetBikeFlags clears the whole byte on
      // every map load, which is why STRENGTH has to be used again next room.
      strengthActive: false,
      // STATUSFLAGS_NO_WILD_ENCOUNTERS_F, driven by `wildoff` / `wildon`.
      noWildEncounters: false,
      // ../pokegold/engine/battle/battle_transition.asm:164
      staleBattleMonLevel: 0,
      staleEnemyMonLevel: 0,
      // Blocks CUT and WHIRLPOOL have swapped out on the loaded map, as
      // { mapId = { [index] = original } }. The cart edits wOverworldMapBlocks,
      // a BUFFER that LoadMapAttributes refills from ROM on every map load --
      // why a cut tree is back next time. Restoring these at the top of setMap
      // is that refill.
      blockEdits: {},
      // engine/overworld/map_setup.asm:78
      objectSpawns: {},
      // A field move that is mid-flow (the used-X text, then its effect).
      fieldMove: undefined,
      // ---- state the script VM owns ----
      // wVariableSprites (ram/wram.asm), indexed from SPRITE.VARS: slot ->
      // plain OverworldSprites byte. Real WRAM that survives a map load, so it
      // survives here too; each map that needs a slot sets it from its own
      // scene script.
      variableSprites: {},
      // The VAR_* slots `writevar` / `loadvar` write. Only VAR.BATTLETYPE is
      // read back today, by the next startbattle.
      scriptVars: {},
      // WarpCheck's find. A script that ends standing on a warp tile must not
      // warp INSIDE the command (the commands behind it would run with the map
      // pulled out from under them), so the destination waits here until
      // World:step sees the VM go idle.
      pendingWarp: undefined,
      // ShakeScreen's live wPlayerStepVectorY offset (`earthquake`).
      shake: undefined,
      // wDontPlayMapMusicOnReload: one shot, consumed by the next map reload.
      dontRestartMusic: false,
      // FadeOutToWhite / FadeOutToBlack's sheet, until a FadeInFrom* lifts it.
      fade: undefined,
      // A `musicfadeout` whose ramp still has frames left, plus the label
      // queued underneath it.
      pendingMusic: undefined,
      // os.getenv("POKEPORT_DEV") == "1": no environment here.
      showDebugHud: false,
    });
    // ow.runner under the Gen 1 name (src/world/OverworldController.lua:216).
    // A mod guards with `ow.runner and ow.runner:isRunning()` before acting;
    // nil there is FALSEY, so the mod would conclude no script is running
    // mid-cutscene. Gold's frame is self.vm, so this is the query half of it
    // and nothing else. (The Lua metatable __index -> getters.)
    self.runner = {
      isRunning: () => self.scriptRunning(),
      get vm() { return self.vm; },
      get co() { return self.vm ? self.vm.co : undefined; },
      get ctx() { return self.vm ? self.vm.ctx : undefined; },
    };
    return self;
  }

  // Lua: World.lua:679-773
  // LoadPlayerData (engine/menus/save.asm) copies sPlayerData straight back
  // over wPlayerData, and ALL THREE of the things this restores live inside
  // that region (ram/wram.asm): wEventFlags, the w<Map>SceneID bytes above it,
  // and wPlayerState below them. So a reload comes back with every flag set
  // and each map on the scene it had reached. MeetMomScript
  // (maps/PlayersHouse1F.asm) needs both halves: talk to MOM, save, reload,
  // and she must NOT replay her first-time scene.
  //
  // `save.events` is the serialized bitfield Events writes (byte index -> byte
  // value, keyed by NUMBER), `save.mapScenes` is map id -> scene id; Save has
  // scrubbed both already. The restore REPLACES the seed rather than merging:
  // a script that CLEARED a seeded flag (MeetMomScript clears
  // EVENT_PLAYERS_HOUSE_MOM_2) has to stay cleared across a reload.
  //
  // Called from World:load BEFORE the first setMap, because the object list is
  // only re-read when a map loads (RefreshMapSprites).
  loadPlayerData(save: any): any {
    this.events = Events.new();
    this.mapScenes = {};
    if (isTable_W1(save)) {
      if (isTable_W1(save.events)) {
        this.events.restore(save.events);
      }
      if (isTable_W1(save.mapScenes)) {
        for (const mapId of Object.keys(save.mapScenes)) {
          this.mapScenes[mapId] = tonumber(save.mapScenes[mapId]) ?? 0;
        }
      }
    }
    // PlayersHouse2FInitializeRoomCallback (maps/PlayersHouse2F.asm) jumps to
    // InitializeEventsScript only while EVENT_INITIALIZED_EVENTS is still
    // clear, and the script sets that flag last. So a save that never had the
    // seed gets it here, and one that has keeps exactly its bitfield.
    if (!truthy(this.events.get(EVENT_INITIALIZED_EVENTS))) {
      for (const id of this.initialEvents ?? []) {
        this.events.set(id, true);
      }
      for (const id of this.initialEngineFlags ?? []) {
        this.setEngineFlag(id, true);
      }
    }
    // Variable sprites: seed any slot the save does not already carry. The
    // cart seeds only on a fresh game (wVariableSprites is never reloaded
    // mid-session), but this port rebuilds the World on every CONTINUE, and an
    // empty slot is an object that does not spawn. Filling only what is
    // missing keeps a later `variablesprite` (Route 36's tree -> TWIN) intact.
    const saved = this.game && this.game.save ? this.game.save.variableSprites : undefined;
    if (isTable_W1(saved)) {
      // Lua `type(slot) == "number"`: JS keys are strings, so numeric ones.
      for (const k of Object.keys(saved)) {
        const slot = Number(k);
        if (k !== "" && Number.isFinite(slot)) this.variableSprites[slot] = saved[k];
      }
    }
    for (const row of this.initialSprites ?? []) {
      if (truthy(row.slot) && truthy(row.sprite) && !truthy(this.variableSprites[row.slot])) {
        this.variableSprites[row.slot] = row.sprite;
      }
    }
    // wPlayerState, the third member of the block. UpdatePlayerSprite picks
    // the sheet off it, .DoStep picks STEP_BIKE/STEP_WALK, and
    // .TranslateIntoMovement picks land or surf perms -- a BICYCLE save that
    // came back on foot walked at the wrong speed over the wrong tiles.
    // Only a name Save.PLAYER_STATES vouches for is taken; anything else is
    // PLAYER_NORMAL. applyPlayerState so a world that already has a player
    // repaints them; on boot the first setMap's CheckUpdatePlayerSprite does.
    const state = isTable_W1(save) ? save.playerState : undefined;
    this.applyPlayerState(state != null && truthy(Gen2Save.PLAYER_STATES[state]) ? state : undefined);
    // wBackupWarpNumber / wBackupMapGroup / wBackupMapNumber, the triple a -1
    // warp destination resolves through (home/map.asm CopyWarpData). Saved in
    // the same WRAM block as wPlayerState, so it rides the save the same way.
    const backup = isTable_W1(save) ? save.backupWarp : undefined;
    if (isTable_W1(backup) && truthy(backup.map) && truthy(backup.warp)) {
      this.backupWarp = { warp: backup.warp, map: backup.map };
    }
    return this.events;
  }

  // Lua: World.lua:775-796
  // The Gen 2 content tables come off game.data rather than off disk: Game2
  // loads them all BEFORE mods:load(self.data), so this hands back the merged
  // table, held by reference on purpose (a copy would un-merge every mod).
  // The fallback covers a World built without a Game2 behind it; the read is
  // cached back into game.data so later readers see the same one table.
  // Returns the table alone: platform/data.ts's loader has no error value, so
  // Lua's second result (err) is always nil here.
  dataTable(key: string, path: string): any {
    const data = this.game ? this.game.data : undefined;
    const held = data ? data[key] : undefined;
    if (held != null) return held;
    const value = loadGenerated(path);
    if (value != null && truthy(data)) data[key] = value;
    return value;
  }

  // Lua: World.lua:798-1510
  load(): boolean {
    // loadGenerated("data/generated/x.lua") -> loadGenerated("x").
    const maps = this.dataTable("gen2Maps", "maps");
    const tilesets = this.dataTable("gen2Tilesets", "tilesets");
    if (!truthy(maps) || !truthy(tilesets)) {
      // Lua printed tostring(mapsErr or tilesErr); our loader has no error
      // string, so the missing table is named instead.
      this.status = Strings.get("Gold cache incomplete:\n%s",
        tostring(!truthy(maps) ? "maps" : "tilesets"));
      return false;
    }
    this.maps = maps;
    this.tilesets = tilesets;
    this.roofs = this.dataTable("gen2Roofs", "roofs");
    this.sprites = this.dataTable("gen2Sprites", "sprites");
    // A pre-#1748 cache stamps a SpriteMons row `frames = 1`, leaving
    // OBJECT_ACTION_BOUNCE one frame -- engine/overworld/map_object_action.asm:184
    for (const k of Object.keys(this.sprites ?? {})) {
      const def = this.sprites[k];
      if (isTable_W1(def) && (def.frames ?? 1) < 2
          && typeof def.source === "string"
          && def.source.startsWith("ROM:SpriteMons")) {
        def.frames = 2;
      }
    }
    // A cache from before the palette stage has no palettes; everything below
    // falls back to the grayscale path rather than failing.
    this.palettes = this.dataTable("gen2Palettes", "palettes");
    // Town-map landmarks for the Pokegear, and the SPAWN_* table that decides
    // where a New Game and every Pokecenter respawn start.
    this.landmarks = this.dataTable("gen2Landmarks", "landmarks");
    this.encounters = this.dataTable("gen2Encounters", "encounters");
    this.stdScripts = this.dataTable("gen2StdScripts", "std_scripts");
    this.trainers = this.dataTable("gen2Trainers", "trainers");
    // data.trainers is the second name the Gen 2 code reads this same table by
    // (World:trainerParty, BugContest, Palettes.trainerPalette); Game2 aliases
    // them before the merge, this catches the fallback path.
    if (this.game && this.game.data && truthy(this.trainers)) {
      this.game.data.trainers = this.trainers;
    }
    // Mart shelves (data/items/marts.asm). A cache without marts gives an
    // empty shelf in MartMenu rather than invented stock.
    this.marts = this.dataTable("gen2Marts", "marts");
    // showemote's bubbles. The Lua built Assets.image objects here; the port
    // keeps the gfx KEYS (the renderer / Gold screen resolves them), so a
    // missing sheet (a cache from before the emote stage) still means no
    // bubble.
    const menuGfx = this.dataTable("gen2MenuGfx", "menu_gfx");
    const emotes = menuGfx ? menuGfx.emotes : undefined;
    if (truthy(emotes)) {
      this.emoteOrder = emotes.order;
      this.emoteImages = {};
      for (const key of emotes.order ?? []) {
        const path = emotes[key];
        if (truthy(path)) this.emoteImages[key] = path;
      }
      // ShakeGrass' one tile (data/sprites/emotes.asm:22).
      if (truthy(emotes.grassRustle)) this.grassRustleImage = emotes.grassRustle;
      // data/sprites/emotes.asm:19
      if (truthy(emotes.jumpShadow)) this.jumpShadowImage = emotes.jumpShadow;
      // engine/events/field_moves.asm:390-407. The Lua's cutGrassQuad (the
      // sheet's first 8x8 of 32x8) is a drawing detail and is dropped.
      if (truthy(emotes.cutGrass)) this.cutGrassImage = emotes.cutGrass;
      // LoadFishingGFX's two sheets
      // (../pokecrystal/engine/events/fishing_gfx.asm:7-12)
      if (truthy(emotes.fishing)) this.fishingSheet = emotes.fishing;
      if (truthy(emotes.fishingFemale)) this.fishingSheetFemale = emotes.fishingFemale;
    }
    // The heal machine's two OBJ tiles and their CGB palette, for the
    // Pokecenter light show (World:startHealMachineAnim). Without the sheet
    // the anim degrades to its sounds. Kept as the gfx key.
    const healMachine = menuGfx ? menuGfx.healMachine : undefined;
    if (truthy(healMachine) && truthy(healMachine.sheet)) {
      this.healMachineImage = healMachine.sheet;
      this.healMachinePalette = healMachine.palette;
    }
    // Lua: World.lua:896-903 -- POKEPORT_GOLD_HOUR / POKEPORT_GOLD_DAY pinned
    // clockHour / clockDay from the environment for drivers; there is no
    // environment here (os.getenv dropped). Set the fields directly instead.
    this.scripts = this.dataTable("gen2Scripts", "scripts") ?? {};
    this.text = this.dataTable("gen2Text", "text") ?? {};
    this.constants = this.dataTable("gen2Constants", "constants") ?? {};
    FieldMoves.bindEngineFlags(this.constants.engineFlagOrder);
    // The side tables a script command NAMES rather than carries: the phone
    // book, the in-game trades, the elevator's floor labels and the decoration
    // descriptions. Optional for every reader.
    this.eventTables = this.dataTable("gen2EventTables", "events") ?? {};
    // Take the phone book off the cache when it has one; Phone keeps its
    // transcribed tables as the fallback for an older cache.
    Phone.useExtracted(this.eventTables);
    // data.pokemon and data.items keep the SHARED Gen 1 keys; going through
    // dataTable keeps every mod's merge instead of re-reading the cache.
    this.dataTable("pokemon", "pokemon");
    this.dataTable("items", "items");
    if (this.game && this.game.save) {
      const save = this.game.save;
      save.party = save.party ?? [];
      save.inventory = save.inventory ?? {};
      save.phoneContacts = save.phoneContacts ?? {};
    }
    // Retail Gold hides story NPCs (lab cop, rivals, etc.) via
    // InitializeEventsScript's setevent list -- apply before spawning people.
    const initial = this.dataTable("gen2InitialEvents", "initial_events");
    this.initialEvents = (initial && initial.flags) ?? [];
    this.initialEngineFlags = (initial && initial.engineFlags) ?? [];
    // InitializeEventsScript also ends with nine `variablesprite`
    // assignments; SPRITE_WEIRD_TREE ($f4) and friends are wVariableSprites
    // SLOTS, so until filled World:resolveSprite answers nil and pooledNpc
    // spawns NOTHING (no Route 36 Sudowoodo, hence no ROCK SMASH, Burned
    // Tower, Morty, FOGBADGE, SURF...). The extractor writes them (`sprites`);
    // the fallback finds the same script in scripts for an older cache.
    this.initialSprites = (initial && truthy(initial.sprites))
      ? initial.sprites : this.findInitialSprites();
    // wEventFlags and the per-map scene ids off the save, with the seed above
    // as the fallback. Both are back before the VM is built and before setMap.
    this.loadPlayerData(this.game ? this.game.save : undefined);
    // Font.load expects the Gen 1 Data shape: data.font = font table. The
    // `font` registry keeps its Gen 1 target, so data.font is already merged.
    const font = this.dataTable("font", "font");
    if (truthy(font)) {
      try {
        Font.load({ font });
      } catch (fontErr) {
        this.status = Strings.get("Font load failed:\n%s", tostring(fontErr));
        return false;
      }
    }

    // Lua: World.lua:972-1446 -- the VM and its world hooks (every hook kept,
    // same names and arity).
    this.vm = Vm.new(this.scripts, this.text, this.events, {
      eventTables: this.eventTables,
      // The `commands` registry as merged into data.commands (the shared Gen 1
      // target). The VM resolves a mod-authored `modcommand` verb out of it;
      // nil is the honest answer for a mod-free boot.
      commands: this.game && this.game.data ? this.game.data.commands : undefined,
      // Vm:resume hands the one-command lookahead through as `stay`
      // (Vm:textStays): the next row is `yesorno`, so this text ended in
      // `done` and the box stays up under YesNoBox (home/text.asm:484). `hold`
      // is the cart `pause` a held box stands through (FindItemInBallScript's
      // `pause 60`).
      showText: (body: any, onDone: any, stay: any, hold: any, sfxWait: any, arrows: any) => {
        this.showText(body, onDone, stay, hold, sfxWait, arrows);
      },
      facePlayer: () => {
        if (this.talkNpc && this.player) {
          this.talkNpc.facePlayer(this.player);
        }
      },
      onFlagsChanged: () => {
        // A flag set MID-SCRIPT must not change which objects are on the map.
        // The cart only re-reads the object list when the map loads
        // (RefreshMapSprites), so MeetMomScript's MOM_1/MOM_2 swap would teleport
        // Mom into her chair mid-sentence. Deferred to the end of the script.
        if (this.scriptRunning()) {
          this.peopleDirty = true;
          return;
        }
        this.rebuildPeople({ seamless: true });
      },
      setScene: (scene: any) => {
        if (this.map) this.mapScenes[this.map.id] = scene ?? 0;
      },
      getScene: () => {
        return this.map ? (this.mapScenes[this.map.id] ?? 0) : 0;
      },
      setMapScene: (group: any, mapNum: any, scene: any) => {
        const mapId = this.mapIdByGroupMap(group, mapNum);
        if (truthy(mapId)) this.mapScenes[mapId!] = scene ?? 0;
      },
      turnObject: (objectId: any, facing: any) => {
        this.turnObject(objectId, facing);
      },
      applyMovement: (objectId: any, bytes: any, onDone: any) => {
        this.beginMovement(objectId, bytes, onDone);
      },
      follow: (leader: any, follower: any) => {
        this.startFollow(leader, follower);
      },
      stopFollow: () => { this.stopFollow(); },
      // StartAutoInput / StopAutoInput (home/joypad.asm). The ring lives on the
      // game so it outlives a map load, stepped once per fixed step ahead of
      // Input:step (core/AutoInput).
      autoInput: (bank: any, address: any) => {
        const ring = this.game ? this.game.autoInput : undefined;
        if (truthy(ring)) ring.startPointer(bank, address, this.game.input);
      },
      autoInputStream: (name: any) => {
        const ring = this.game ? this.game.autoInput : undefined;
        if (truthy(ring)) ring.start(name, this.game.input);
      },
      stopAutoInput: () => {
        const ring = this.game ? this.game.autoInput : undefined;
        if (truthy(ring)) ring.stop(this.game.input);
      },
      yesorno: (onChoose: any) => {
        this.askYesNo(onChoose);
      },
      disappear: (objectId: any) => {
        this.disappearObject(objectId);
      },
      showPic: (speciesIndex: any) => {
        this.showPokePic(speciesIndex);
      },
      hidePic: () => {
        this.pokePic = undefined;
      },
      // WaitButton (home/text.asm), for the `waitbutton` under an open
      // `pokepic` window with no text box to take the press. See
      // World:waitForButton.
      waitButton: (done: any) => {
        this.waitForButton(done);
      },
      getMonName: (speciesIndex: any) => {
        const [id, def] = speciesByIndex(
          this.game && this.game.data ? this.game.data.pokemon : undefined,
          speciesIndex);
        if (def && truthy(def.name)) return def.name;
        return id ?? "?";
      },
      getItemName: (itemIndex: any) => {
        const [id, def] = itemByIndex(
          this.game && this.game.data ? this.game.data.items : undefined, itemIndex);
        if (def && truthy(def.name)) return def.name;
        return id ?? ("ITEM" + tostring(itemIndex));
      },
      // CheckItemPocket (engine/items/items.asm) on wCurItem: the pocket id
      // behind ItemPocketNames, for _PutItemInPocketText / _PocketIsFullText.
      getItemPocket: (itemIndex: any) => {
        const [, def] = itemByIndex(
          this.game && this.game.data ? this.game.data.items : undefined, itemIndex);
        return def && truthy(def.pocket) ? def.pocket : undefined;
      },
      // GetTrainerName, not Battle_GetTrainerName: the operand pair IS the
      // class and member. CAL takes its own arm (TrainerHouse).
      getTrainerName: (group: any, index: any) => {
        return TrainerHouse.name(this.game && this.game.data
          ? this.game.data.trainers : undefined, this.game ? this.game.save : undefined,
          group, index);
      },
      // Mirror wStringBuffer2 onto the game so the shared {STRBUF} token can
      // fill any page the VM itself did not build.
      setStringBuffer: (value: any) => {
        if (this.game) this.game.stringBuffer = value;
      },
      givePoke: (speciesIndex: any, level: any, item: any, opts: any) => {
        const data = this.game ? this.game.data : undefined;
        const save = this.game ? this.game.save : undefined;
        if (!(truthy(data) && truthy(save))) return undefined;
        save.party = save.party ?? [];
        const mon = givePokeMon(data, speciesIndex, level, item, opts);
        if (truthy(mon)) {
          if (opts && truthy(opts.otName)) {
            mon.ot = opts.otName;
            mon.otName = opts.otName;
            mon.otId = RANDY_OT_ID;
          }
          // GivePoke -> TryAddMonToParty -> AddPartyMon (move_mon.asm:44-56, :143-149).
          Mon.stampOT(save, mon);
          // move_mon.asm:1734, :1761
          if (truthy(Mon.hasCaughtData(save.version))) {
            if (opts && truthy(opts.otName)) {
              Mon.setGiftCaughtData(mon, truthy(opts.caughtBy) ? opts.caughtBy : "unknown");
            } else {
              Catching.stampCaughtData(mon, this.caughtDataOpts());
            }
          }
          Party.add(save.party, mon);
          // GivePoke ends in SetSeenAndCaughtMon, which is why the STARTER is
          // already ticked off in the #DEX before the first battle.
          save.pokedex = save.pokedex ?? { seen: {}, caught: {} };
          save.pokedex.seen[mon.species] = true;
          save.pokedex.caught[mon.species] = true;
          // AddPartyMon's `.registerunowndex` runs on the same path, so a
          // gifted Unown lands in the form list too (move_mon.asm:347).
          Unown.registerCatch(save, mon);
        }
        // engine/pokemon/move_mon.asm:1632-1645
        return mon;
      },
      giveItem: (itemIndex: any, qty: any) => {
        const data = this.game ? this.game.data : undefined;
        const save = this.game ? this.game.save : undefined;
        if (!truthy(save)) return false;
        save.inventory = save.inventory ?? {};
        let id: string | undefined = itemByIndex(data ? data.items : undefined, itemIndex)[0];
        if (!truthy(id)) {
          id = "ITEM_" + tostring(itemIndex);
        }
        return Bag.add(save, id!, qty ?? 1, data);
      },
      addCell: (phone: any) => {
        const save = this.game ? this.game.save : undefined;
        if (!truthy(save)) return;
        save.phoneContacts = save.phoneContacts ?? {};
        save.phoneContacts[phone] = true;
      },
      delCell: (phone: any) => {
        const save = this.game ? this.game.save : undefined;
        if (!truthy(save) || !truthy(save.phoneContacts)) return;
        delete save.phoneContacts[phone];
      },
      hasCell: (phone: any) => {
        const save = this.game ? this.game.save : undefined;
        return truthy(save) && truthy(save.phoneContacts) && save.phoneContacts[phone] === true;
      },
      cry: (speciesIndex: any) => {
        this.playCry(speciesIndex);
      },
      playSound: (sfxId: any) => {
        // home/audio.asm:180
        Sound.dropPressSfx();
        this.playSfx(sfxId);
      },
      playMusic: (musicId: any) => {
        this.playMusicId(musicId);
      },
      specialSound: (itemIndex: any) => { this.specialSound(itemIndex); },
      // WaitSFX is `call CheckSFX / jr c, WaitSFX` on wCurSFX, so it waits on
      // WHATEVER sound is on the channels. Phone_StartRinging
      // (engine/phone/phone.asm:564) needs that: the A-press beep before the
      // call is likely still running, and SFX_CALL ($6a) is quiet enough that
      // the priority gate drops the ring over one. Sound.sfxBusy() is that
      // wCurSFX; World.lastSfx only covers sounds World itself started (a LÖVE
      // Source in the Lua; its methods are guarded here).
      waitSfx: () => {
        if (truthy(Sound.sfxBusy())) return false;
        const src = this.lastSfx;
        if (!truthy(src)) return true;
        const [ok, playing] = pcallMethod_W1(src, "isPlaying");
        return !(ok && truthy(playing));
      },
      waitSfxCap: () => {
        let left = Sound.sfxRemaining();
        const src = this.lastSfx;
        let okp = false;
        let playing: any = false;
        if (truthy(src)) [okp, playing] = pcallMethod_W1(src, "isPlaying");
        if (okp && truthy(playing)) {
          const [okd, dur] = pcallMethod_W1(src, "getDuration");
          const [okt, pos] = pcallMethod_W1(src, "tell");
          if (!(okd && okt)) return undefined;
          if (typeof dur !== "number" || typeof pos !== "number") return undefined;
          const rest = Math.max(0, dur - pos);
          if (left == null || rest > left) left = rest;
        }
        if (left == null) return undefined;
        return Math.ceil(left * 60) + 30;
      },
      readVar: (varId: any) => {
        return this.readVar(varId);
      },
      // `special` ids resolve through the extracted SpecialsPointers order.
      specialOrder: this.constants ? this.constants.specialOrder : undefined,
      lookupTrainer: (klass: any, member: any) => {
        return this.trainerParty(klass, member);
      },
      startBattle: (trainer: any, wild: any, onDone: any) => {
        this.startScriptedBattle(trainer, wild, onDone);
      },
      catchTutorial: (wild: any, battleType: any, onDone: any) => {
        this.startCatchTutorial(wild, battleType, onDone);
      },
      // `setup` is true for the ops that run a map SETUP script (`reloadmap`,
      // `reloadmapafterbattle`), false for `refreshmap`, which runs no setup
      // script (engine/overworld/scripting.asm:2044). Only the setup arm
      // carries the music row, and it runs BEFORE the deferral below so a
      // reload mid-scene still consumes wDontPlayMapMusicOnReload.
      reloadMap: (setup: any) => {
        if (truthy(setup)) {
          this.forceMapMusic();
          this.battleReturnFade();
          // Script_reloadmap re-enters through MAPSTATUS_ENTER
          // (engine/overworld/scripting.asm:1108-1116), so a wild battle
          // re-arms EnterMap's cooldown.
          this.wildCooldown = 5;
        }
        // MapSetupScript_ReloadMap (data/maps/setup_scripts.asm:124) has NO
        // LoadMapObjects, so a flag set BEFORE the battle must not cull anybody
        // mid-scene (AzaleaTownRivalBattleScript sets EVENT_RIVAL_AZALEA_TOWN
        // well before `startbattle`). Same deferral as onFlagsChanged.
        if (this.scriptRunning()) {
          this.peopleDirty = true;
          return;
        }
        this.rebuildPeople({ seamless: true });
      },
      // `warp NONE, 0, 0`, Script_warp's own group-0 arm: MapSetupScript_BadWarp
      // carries HandleNewMap and LoadMapObjects (ReloadMap carries neither),
      // and the bedroom PC's warp is there to re-run those callbacks.
      badWarp: () => { this.reloadMapBadWarp("bad_warp"); },
      encounterMusic: (klass: any) => {
        this.playTrainerEncounterMusic(klass);
      },
      showEmote: (emote: any, object: any, frames: any) => {
        this.showEmote(emote, object, frames);
      },
      trainerApproach: (onDone: any) => { this.trainerApproach(onDone); },
      faceObject: (a: any, b: any) => {
        // faceobject PLAYER, LAST_TALKED: PLAYER is 0, LAST_TALKED is -1/$fe,
        // and only the player-turns-to-trainer case is ever scripted here.
        if ((a ?? 0) === 0 && this.player && this.trainerNpc) {
          const dx = this.trainerNpc.cellX - this.player.cellX;
          const dy = this.trainerNpc.cellY - this.player.cellY;
          if (Math.abs(dx) > Math.abs(dy)) {
            this.player.facing = dx > 0 ? "right" : "left";
          } else if (dy !== 0) {
            this.player.facing = dy > 0 ? "down" : "up";
          }
        }
        void b;
      },
      openPc: () => { this.openPc(); },
      // engine/menus/menu_2.asm's three balance boxes: each `special` draws a
      // box and RETURNS, and every call is followed by `loadmenu`, so the box
      // belongs to the static menu that answers -- remembered here and handed
      // to that screen.
      showCoins: () => { this.scriptBalance = "coins"; },
      showMoney: (kind: any) => { this.scriptBalance = truthy(kind) ? kind : "money"; },
      openMart: (martType: any, martId: any, onDone: any) => {
        this.openMart(martType, martId, onDone);
      },
      openMenu: (header: any, style: any, onChoose: any) => {
        this.openScriptMenu(header, style, onChoose);
      },
      elevator: (floors: any, onDone: any) => {
        this.openElevator(floors, onDone);
      },
      npcTrade: (id: any, onDone: any) => {
        this.openNpcTrade(id, onDone);
      },
      // Script_wildoff / Script_wildon (engine/overworld/scripting.asm), which
      // set and clear STATUSFLAGS_NO_WILD_ENCOUNTERS_F.
      setWildEncounters: (on: any) => {
        this.noWildEncounters = !truthy(on);
      },
      healParty: () => { this.healParty(); },
      healAnim: (animType: any, onDone: any) => {
        this.startHealMachineAnim(animType, onDone);
      },
      nameRival: (onDone: any) => { this.nameRival(onDone); },
      warpToSpawn: () => { this.warpToSpawn(); },

      // ---- scene, clock, cartridge ----
      getMapScene: (group: any, mapNum: any) => {
        return this.mapSceneOf(group, mapNum);
      },
      getTimeOfDay: () => this.timeOfDayId(),
      gsVersion: () => this.gsVersion(),

      // ---- ENGINE_* flags ----
      // A DIFFERENT namespace from `setevent`'s wEventFlags: badges, the
      // Pokegear cards, ENGINE_POKEDEX, the Bug Contest timer. None decides
      // whether an object is on the map, so neither hook touches
      // onFlagsChanged.
      getEngineFlag: (flag: any) => this.engineFlag(flag),
      setEngineFlag: (flag: any, value: any) => { this.setEngineFlag(flag, value); },

      // ---- vars ----
      writeVar: (varId: any, value: any) => { this.writeVar(varId, value); },
      // `callasm` / `memcallasm`: raw GB code at bank:addr. The importer does
      // not resolve the pair against the .sym, so `label` is nil and the
      // ADDRESS dispatches (script/CallAsm keys on it). A nil back leaves
      // wScriptVar alone.
      callAsm: (label: any, bank: any, addr: any) => {
        return this.callAsm(label, bank, addr);
      },

      // ---- map objects ----
      appear: (objectId: any) => { this.appearObject(objectId); },
      moveObject: (objectId: any, cx: any, cy: any) => {
        this.moveObject(objectId, cx, cy);
      },
      variableSprite: (slot: any, sprite: any) => {
        this.setVariableSprite(slot, sprite);
      },
      // DescribeDecoration's read of the wDeco* byte its arm names, plus
      // GetDecorationName_c_de's wStringBuffer3 for the three arms that print
      // it. Lua's two results -> [decoId, name] (Vm reads it with asPair).
      decorationSlot: (descName: any) => {
        const desc = Decorations.DESC_SLOTS[descName ?? ""];
        if (!truthy(desc)) return undefined;
        const state = Decorations.state(this.game ? this.game.save : undefined);
        const decoId = state[desc.slot] ?? 0;
        if (decoId === 0) return [0, undefined];
        return [decoId, truthy(desc.named) ? Decorations.name(decoId) : undefined];
      },
      // LoadEmote is a VRAM preload; World:showEmote picks the sheet by index
      // at draw time, so there is nothing to warm up. The VM keeps its own
      // `loadedEmote` for the movement byte that carries no id.

      // ---- map blocks and warps ----
      changeBlock: (bx: any, by: any, blockId: any) => {
        this.changeBlock(bx, by, blockId);
      },
      changeMapBlocks: (bank: any, address: any) => {
        return this.changeMapBlocks(bank, address);
      },
      earthquake: (displacement: any, frames: any) => {
        this.earthquake(displacement, frames);
      },
      warpTo: (group: any, mapNum: any, cx: any, cy: any, facing: any) => {
        this.warpTo(group, mapNum, cx, cy, facing);
      },
      warpCheck: () => { this.armWarpCheck(); },
      warpSound: () => { this.warpSound(); },
      writeCmdQueue: () => this.writeCmdQueue(),
      delCmdQueue: (kind: any) => this.delCmdQueue(kind),
      newLoadMap: (method: any) => { this.newLoadMap(method); },
      setWarpMod: (warpId: any, group: any, mapNum: any) => {
        this.setWarpMod(warpId, group, mapNum);
      },
      setBlackoutMap: (group: any, mapNum: any) => {
        this.setBlackoutMap(group, mapNum);
      },

      // ---- encounters ----
      setSwarm: (group: any, mapNum: any, kind: any) => { this.setSwarm(group, mapNum, kind); },
      rollWild: () => this.rollWild(),
      // The WRAM bytes the ENGINE owns rather than the script: nil means "not
      // mine", and the VM falls back to its own sparse store.
      readMem: (addr: any) => this.scriptReadMem(addr),

      // ---- music ----
      playMapMusic: () => { this.playMapMusic(); },
      fadeOutMusic: (musicId: any, fade: any) => { this.fadeOutMusic(musicId, fade); },
      dontRestartMapMusic: () => { this.dontRestartMusic = true; },

      // ---- bag, money and coins ----
      hasItem: (itemIndex: any) => this.hasItem(itemIndex),
      takeItem: (itemIndex: any, qty: any) => {
        return this.takeItem(itemIndex, qty);
      },
      getMoney: (account: any) => this.money(account),
      setMoney: (account: any, value: any) => { this.setMoney(account, value); },
      getCoins: () => this.coins(),
      setCoins: (value: any) => { this.setCoins(value); },

      // ---- party ----
      hasPoke: (speciesIndex: any) => this.hasPoke(speciesIndex),
      giveEgg: (speciesIndex: any, level: any) => {
        return this.giveEgg(speciesIndex, level);
      },
      // `givepokemail` / `checkpokemail` are script COMMANDS ($ea, $eb), not
      // SpecialsPointers rows, so they sit on the VM's own hook table beside
      // giveegg (also listed in `specials` below).
      givePokeMail: (mail: any) => this.givePokeMail(mail),
      checkPokeMail: (mail: any, onDone: any) => { this.checkPokeMail(mail, onDone); },
      getLandmarkName: () => this.landmarkName(),

      // ---- field events ----
      fruitTreeItem: (tree: any) => this.fruitTreeItem(tree),
      fruitTreeReset: () => this.fruitTreeReset(),
      fruitTreePicked: (tree: any) => this.fruitTreePicked(tree),
      fruitTreePick: (tree: any) => { this.fruitTreePick(tree); },

      // ---- phone ----
      addPhoneNumber: (contact: any) => this.addPhoneNumber(contact),
      setSpecialCall: (id: any) => { this.setSpecialCall(id); },
      getSpecialCall: () => this.specialCall(),

      // ---- end of game ----
      // Script_halloffame and Script_credits both end on ReturnFromCredits
      // (Script_endall + MAPSTATUS_DONE), so the VM returns out of the script
      // the moment either hook is present. Script COMMANDS ($9f, $a0), not
      // SpecialsPointers rows.
      hallOfFame: (onDone: any) => { this.hallOfFame(onDone); },
      credits: (onDone: any) => { this.credits(onDone); },

      // ---- the specials ----
      // Everything under script/Specials that has to touch the world reaches
      // it through this ONE sub-table: a special is an independent routine and
      // the table is its whole surface.
      specials: this.specialHooks(),
    });

    // The readmem / writemem bytes a script owns outright (the Goldenrod
    // underground switches, wMooMooBerries) ride the save under `scriptMem`;
    // hand them back before any script runs.
    const savedMem = this.game && this.game.save ? this.game.save.scriptMem : undefined;
    if (truthy(savedMem)) this.vm.restoreMem(savedMem);

    // Where to start: a restored save's own position, else SPAWN_HOME.
    let startMap: string = START_MAP;
    let startX: number = START_X;
    let startY: number = START_Y;
    let startFacing: any = START_FACING;
    const spawn = this.landmarks && this.landmarks.spawns
      ? this.landmarks.spawns[SPAWN_HOME] : undefined;
    if (spawn && truthy(spawn.map) && truthy(maps[spawn.map])) {
      startMap = spawn.map; startX = spawn.x; startY = spawn.y;
    }
    const saved = this.game && this.game.save ? this.game.save.position : undefined;
    // Which map setup script this load is (engine/menus/intro_menu.asm): a
    // file with a recorded position is CONTINUE, a New Game is the SPAWN_HOME
    // warp. setMap reads it back for HandleNewMap's temporary-flag reset.
    let isContinue = false;
    if (saved && truthy(saved.map) && truthy(maps[saved.map])) {
      startMap = saved.map; startX = saved.x; startY = saved.y;
      startFacing = truthy(saved.facing) ? saved.facing : startFacing;
      isContinue = true;
    }
    // `farcall JumpRoamMons`, three lines above that same read: EVERY load of
    // a save scatters the three beasts before the map comes back. The map the
    // jump avoids is the one the save was written on, so this runs while
    // startMap is still the SAVED position, not the post-credits spawn below.
    this.roamMonsOnContinue(startMap);
    // Continue (engine/menus/intro_menu.asm): a pending wSpawnAfterChampion
    // replaces the saved position outright (.SpawnAfterE4 / SpawnAfterRed ->
    // PostCreditsSpawn's MAPSETUP.WARP), so the champion continues in New Bark
    // Town, not in a room whose only exit is sealed.
    const post = this.consumePostGameSpawn();
    if (truthy(post)) {
      startMap = post.map; startX = post.x; startY = post.y; startFacing = "down";
      isContinue = false;
    }

    if (!truthy(maps[startMap])) {
      this.status = Strings.get("%s is missing.\nRe-import the Gold ROM.",
        tostring(startMap));
      return false;
    }
    try {
      this.setMap(startMap, startX, startY, startFacing, { continue: isContinue });
    } catch (err) {
      this.status = Strings.get("Failed to boot %s:\n%s",
        tostring(startMap), tostring(err));
      return false;
    }
    return this.map != null;
  }

  // Lua: World.lua:1512-1516
  // Just the VM, not everything World:busy covers: a deferred object rebuild
  // has to wait for the SCRIPT, not for the text box showing its line.
  scriptRunning(): boolean {
    return (this.vm && truthy(this.vm.running())) ? true : false;
  }

  // Lua: World.lua:1518-1543
  busy(): boolean {
    return truthy(this.vm && this.vm.running())
      // The map setup script is a blocking call inside the cart's overworld
      // loop (RunMapSetupScript), so nothing else may run while it does --
      // least of all a step from a direction still held from before the warp.
      || this.mapSetup != null
      || this.textbox != null
      || this.moveState != null
      || this.choicebox != null
      // The rod cast and the tree shake are frame counters with no text box up
      // for part of their run; on the cart they are script commands, so the
      // world is frozen for them too.
      || this.fishing != null
      || this.headbutt != null
      // A field move's tail (surf step, STRENGTH pause, waterfall climb) is
      // applymovement / pause inside a queued script.
      || this.fieldMove != null
      // FlyFromAnim and FlyToAnim are blocking `callasm`s inside .FlyScript
      // (engine/events/overworld.asm:599, :605).
      || this.flyAnim != null
      // engine/overworld/events.asm:1011
      || this.skyfall != null;
  }

  // Lua: World.lua:1545-1565
  // CheckMenuOW (engine/overworld/events.asm:802) is the tail of OWPlayerInput,
  // only reached from PlayerEvents, which returns while wScriptRunning is set
  // (events.asm:238-243). Two more gates: PlayerMovement answering
  // PLAYERMOVEMENT_CONTINUE (mid-step, events.asm:474-477) and
  // CheckStandingOnIce carrying (events.asm:479-480). The frame a step is
  // QUEUED answers PLAYERMOVEMENT_FINISH (player_movement.asm:455-461), zero,
  // so the poll still runs there -- on the Cycling Road's forced roll that
  // landing frame is the only one there is (#1718).
  acceptsMenuInput(): boolean {
    if (truthy(this.battleActive) || this.busy()) return false;
    if (this.player && truthy(this.player.moving) && !truthy(this.stepFinished)) {
      return false;
    }
    // The same latch pair World:step's slide uses: a latched direction on an
    // ice tile is CheckStandingOnIce's carry.
    if (truthy(this.turningDirection) && truthy(Permissions.isIce(this.playerCollision()))) {
      return false;
    }
    return true;
  }

  // Lua: World.lua:1567-1575
  mapIdByGroupMap(group: any, mapNum: any): string | undefined {
    if (!this.maps) return undefined;
    for (const id of Object.keys(this.maps)) {
      const def = this.maps[id];
      if (isTable_W1(def) && def.group === group && def.map === mapNum) {
        return id;
      }
    }
    return undefined;
  }

  // Lua: World.lua:1577-1580
  scene(): number {
    if (!this.map) return 0;
    return this.mapScenes[this.map.id] ?? 0;
  }

  // ---- the script VM's world hooks ----
  // Lua: World.lua:1582-1590 -- everything from here to World:specialHooks is
  // one script command or one special reaching into the world: the WORLD half
  // of a routine whose other half is in script/Vm or Specials. The VM guards
  // every call with `if self.xFn then`, so a missing hook only stops it
  // SHOWING the result.

  // Lua: World.lua:1591-1601
  // GetMapSceneID (engine/overworld/scripting.asm): a map with no `scene_var`
  // row leaves de = 0 and Script_checkmapscene answers $ff, which is what nil
  // means here. A map that HAS scene scripts but was never given a scene is 0.
  mapSceneOf(group: any, mapNum: any): number | undefined {
    const mapId = this.mapIdByGroupMap(group, mapNum);
    if (!truthy(mapId)) return undefined;
    const def = this.maps ? this.maps[mapId!] : undefined;
    if (!(def && truthy(def.sceneScripts))) return undefined;
    return this.mapScenes[mapId!] ?? 0;
  }

  // Lua: World.lua:1607-1609
  timeOfDayId(): number {
    const key = truthy(this.tod) ? this.tod : truthy(this.daytime) ? this.daytime : "DAY";
    return TIME_OF_DAY_ID[key] ?? 1;
  }

  // Lua: World.lua:1611-1625 -- caught_data.asm:168-199
  caughtDataOpts(): any {
    const save = this.game ? this.game.save : undefined;
    const opts: any = {
      version: save ? save.version : undefined,
      save,
      data: this.game ? this.game.data : undefined,
      timeOfDay: this.timeOfDayId(),
      map: this.map ? this.map.def : undefined,
      backupMap: truthy(this.backupMapId) && this.maps ? this.maps[this.backupMapId] : undefined,
      playerGender: save && save.player ? save.player.gender : undefined,
    };
    opts.landmark = Catching.caughtLandmark(opts);
    return opts;
  }

  // Lua: World.lua:1627-1636
  // GetWeekday -> wCurDay, which the RTC counts SUNDAY 0 .. SATURDAY 6 -- the
  // same numbering os.date("%w") answers. `clockDay` overrides the host clock
  // the way `clockHour` overrides the hour.
  weekday(): number {
    if (truthy(this.clockDay)) return mod(Math.floor(this.clockDay), 7);
    // Through the base InitDayOfWeek stored, not the host clock raw: Mom's
    // wheel decides which day the game is on (core/Clock).
    return Clock.weekday(this.game ? this.game.save : undefined);
  }

  // Lua: World.lua:1638-1646
  // hHours, which VAR.HOUR reads straight off: RTC hour 0..23. `clockHour`
  // overrides the host clock the same way it does for the daytime palette.
  hour(): number {
    if (truthy(this.clockHour)) return mod(Math.floor(this.clockHour), 24);
    // CalcNSecsHoursDaysSince reads the RTC through wStartHour / wStartMinute,
    // the base InitClock wrote; a save without a base reads the host clock.
    return Clock.hour(this.game ? this.game.save : undefined);
  }

  // Lua: World.lua:1648-1652
  // hMinutes, the other half of the same read (Pokegear clock card, DST).
  minute(): number {
    return Clock.minute(this.game ? this.game.save : undefined);
  }

  // Lua: World.lua:1654-1729
  // engine/overworld/variables.asm .VarActionTable, walked in order. readVar
  // and writevar/loadvar share the id space, but only the ADDR_DE rows
  // (VAR.BATTLETYPE, VAR.MOVEMENT) are written back through writeVar; the rest
  // are RETVAR_EXECUTE / RETVAR_STRBUF2 rows reading engine-owned state.
  readVar(varId: number): number {
    if (varId === VAR.FACING && this.player) {
      return FACING_ID[this.player.facing] ?? 0;
    }
    if (varId === VAR.WEEKDAY) return this.weekday();
    if (varId === VAR.BATTLETYPE) return this.scriptVars[VAR.BATTLETYPE] ?? 0;
    const save = this.game ? this.game.save : undefined;
    if (varId === VAR.PARTYCOUNT) {
      return save ? (save.party ?? []).length : 0;
    }
    if (varId === VAR.BATTLERESULT) {
      // wBattleResult masked with ~BATTLERESULT_BITMASK (the box-full flag);
      // the port never sets that bit, so the stored value already matches.
      return this.lastBattleResult ?? 0;
    }
    if (varId === VAR.TIMEOFDAY) return this.timeOfDayId();
    if (varId === VAR.DEXCAUGHT) {
      return countFlags(save && save.pokedex ? save.pokedex.caught : undefined);
    }
    if (varId === VAR.DEXSEEN) {
      return countFlags(save && save.pokedex ? save.pokedex.seen : undefined);
    }
    if (varId === VAR.BADGES) {
      // wBadges is TWO bytes (Johto then Kanto); CountSetBits walks both.
      const player = save ? save.player : undefined;
      return countFlags(player ? player.badges : undefined)
        + countFlags(player ? player.kantoBadges : undefined);
    }
    if (varId === VAR.MOVEMENT) {
      return PLAYER_STATE_ID[this.playerState] ?? 0;
    }
    if (varId === VAR.HOUR) return this.hour();
    if (varId === VAR.MAPGROUP) {
      return (this.map && this.map.def ? this.map.def.group : undefined) ?? 0;
    }
    if (varId === VAR.MAPNUMBER) {
      return (this.map && this.map.def ? this.map.def.map : undefined) ?? 0;
    }
    if (varId === VAR.UNOWNCOUNT) {
      // CountUnown walks wUnownDex, the distinct Unown FORMS caught in order;
      // that is its own record (save.unownDex, core/Unown).
      return Unown.count(save);
    }
    if (varId === VAR.ENVIRONMENT) {
      return (this.map && this.map.def ? this.map.def.environmentId : undefined) ?? 0;
    }
    if (varId === VAR.BOXSPACE) {
      if (!truthy(save)) return 0;
      return Boxes.MONS_PER_BOX - Boxes.count(save, save.currentBox);
    }
    if (varId === VAR.CONTESTMINUTES) {
      if (!truthy(save)) return 0;
      const minutes = BugContest.timeLeft(save);
      return minutes;
    }
    if (varId === VAR.XCOORD) {
      return (this.player ? this.player.cellX : undefined) ?? 0;
    }
    if (varId === VAR.YCOORD) {
      return (this.player ? this.player.cellY : undefined) ?? 0;
    }
    if (varId === VAR.SPECIALPHONECALL) {
      return this.specialCall();
    }
    if (varId >= VAR.BT_WIN_STREAK && varId <= VAR.KENJI_BREAK) {
      return this.crystalVar(varId);
    }
    return 0;
  }

  // Lua: World.lua:1731-1761
  // ../pokecrystal/engine/overworld/variables.asm:62-67, the six
  // .VarActionTable rows Crystal appends past VAR_SPECIALPHONECALL.
  crystalVar(varId: number): number {
    // ../pokecrystal/ram/wram.asm:3286 wCurCaller, parked on the VM
    // (script/CallAsm.lua:190).
    if (varId === VAR.CALLERID) {
      return (this.vm ? this.vm.curPhoneCaller : undefined) ?? 0;
    }
    const save = this.game ? this.game.save : undefined;
    if (!truthy(save)) return 0;
    // ../pokecrystal/ram/wram.asm:1703 wNrOfBeatenBattleTowerTrainers.
    if (varId === VAR.BT_WIN_STREAK) {
      return byteOf(Gen2Save.battleTowerState(save).streak);
    }
    // ../pokecrystal/engine/events/kurt.asm:24,45 wKurtApricornQuantity.
    if (varId === VAR.KURT_APRICORNS) {
      return byteOf(save.kurtApricornQuantity);
    }
    const crystal = Gen2Save.crystalState(save);
    if (varId === VAR.BLUECARDBALANCE) {
      return byteOf(crystal.buenaPassword.balance);
    }
    if (varId === VAR.BUENASPASSWORD) {
      return byteOf(crystal.buenaPassword.word);
    }
    // ../pokecrystal/engine/overworld/time.asm:136 SampleKenjiBreakCountdown.
    if (varId === VAR.KENJI_BREAK) {
      return byteOf(crystal.kenjiBreak);
    }
    return 0;
  }

  // Lua: World.lua:1763-1780
  // The three of them Script_writevar can reach: RETVAR_ADDR_DE rows write the
  // variable itself, RETVAR_STRBUF2 rows write the scratch buffer and are lost
  // (../pokecrystal/engine/overworld/variables.asm:21-25).
  setCrystalVar(varId: number, value: any): void {
    value = byteOf(value);
    if (varId === VAR.CALLERID) {
      if (this.vm) this.vm.curPhoneCaller = value;
      return;
    }
    const save = this.game ? this.game.save : undefined;
    if (!truthy(save)) return;
    const buena = Gen2Save.crystalState(save).buenaPassword;
    if (varId === VAR.BLUECARDBALANCE) {
      buena.balance = value;
    } else if (varId === VAR.BUENASPASSWORD) {
      buena.word = value;
    }
  }

  // Lua: World.lua:1782-1788
  // ../pokecrystal/engine/events/kurt.asm:19-45 SelectApricornForKurt, whose
  // byte is what `verbosegiveitemvar <BALL>, VAR_KURT_APRICORNS` hands over.
  setKurtApricornQuantity(count: any): void {
    const save = this.game ? this.game.save : undefined;
    if (!truthy(save)) return;
    save.kurtApricornQuantity = byteOf(count);
  }

  // Lua: World.lua:1790-1795 -- ../pokecrystal/engine/overworld/time.asm:136-142,
  // the 3..6 day roll.
  setKenjiBreak(days: any): void {
    const save = this.game ? this.game.save : undefined;
    if (!truthy(save)) return;
    Gen2Save.crystalState(save).kenjiBreak = byteOf(days);
  }

  // Lua: World.lua:1797-1804
  // Script_checkver: 0 for Gold, 1 for Silver (constants/misc_constants.asm
  // GS_VERSION).
  gsVersion(): number {
    const save = this.game ? this.game.save : undefined;
    const version = save && truthy(save.version) ? save.version : GameVersion.get();
    return version === "silver" ? 1 : 0;
  }

  // Lua: World.lua:1806-1812
  isCrystal(): boolean {
    // Rendering follows the loaded ROM column (BorderFill / MapPreview do the
    // same), not save.version -- a Crystal save under the Gold column still
    // bakes and draws with Gold's single-bank tilesets.
    return GameVersion.engine() === "crystal";
  }

  // Lua: World.lua:1814-1827
  // ENGINE_* flags (data/events/engine_flags.asm), the namespace `setflag` /
  // `clearflag` / `checkflag` write. Kept on the save under its own key rather
  // than merged into `events`: the cart indexes different arrays (wEngineBuffer
  // / wBadges / wPokegearFlags vs wEventFlags), and a collision would have
  // BADGE_ZEPHYR hide an NPC. It does NOT rebuild the map's people: no engine
  // flag names an object's MAPOBJECT_EVENT_FLAG.
  engineFlags(): any {
    const save = this.game ? this.game.save : undefined;
    if (!truthy(save)) return this._engineFlags ?? {};
    save.engineFlags = save.engineFlags ?? {};
    return save.engineFlags;
  }

  // Lua: World.lua:1829-1874
  engineFlag(flag: any): boolean {
    if (flag == null) return false;
    const save = this.game ? this.game.save : undefined;
    // ENGINE_BUG_CONTEST_TIMER IS save.bugContest.active: that is what
    // CheckTimeEvents polls and RandomEncounter branches on; a second copy in
    // the flag table is how the two would come apart.
    if (flag === FieldMoves.BUG_CONTEST_FLAG && truthy(save)) {
      return truthy(BugContest.isActive(save));
    }
    // Badges live in save.player.badges: on the cart the ENGINE_*BADGE ids ARE
    // the bits of wJohtoBadges/wKantoBadges, one store for everything that
    // asks. See FieldMoves.BADGE_FLAG.
    const badge = FieldMoves.BADGE_FLAG[flag];
    if (truthy(badge) && truthy(save)) {
      const player = save.player;
      const owned = player ? player[badge.store] : undefined;
      return isTable_W1(owned) && owned[badge.name] === true;
    }
    // Same one-store rule for ENGINE_PLAYER_IS_FEMALE, which IS wPlayerGender
    // (../pokecrystal/data/events/engine_flags.asm:131); Gold's FEMALE_FLAG is nil.
    if (flag === FieldMoves.FEMALE_FLAG) {
      return truthy(Gen2Save.isFemale(save));
    }
    // Same one-store rule for the day care: data/events/engine_flags.asm:18-20
    // maps the three ids onto the DAYCAREMAN/LADY bits the deposit routines
    // write, so `checkflag` reads the deposit state directly (Route34EggCheck-
    // Callback branches on all three, maps/Route34.asm:21-49).
    if (truthy(save)) {
      if (flag === ENGINE.DAY_CARE_MAN_HAS_EGG) {
        return Breeding.dayCare(save)!.hasEgg === true;
      } else if (flag === ENGINE.DAY_CARE_MAN_HAS_MON) {
        return (Breeding.side(save, "man") ?? {}).mon != null;
      } else if (flag === ENGINE.DAY_CARE_LADY_HAS_MON) {
        return (Breeding.side(save, "lady") ?? {}).mon != null;
      }
    }
    return this.engineFlags()[flag] === true;
  }

  // Lua: World.lua:1876-1920
  setEngineFlag(flag: any, value: any): void {
    if (flag == null) return;
    const save = this.game ? this.game.save : undefined;
    if (flag === FieldMoves.BUG_CONTEST_FLAG && truthy(save)) {
      // Route35NationalParkGate_OkayToProceed sets the flag BEFORE `special
      // GiveParkBalls`, so starting here and again there is the cart's order.
      // BugContestResultsScript's clearflag is the stop and leaves the caught
      // mon alone: CheckPartyFullAfterContest runs after it.
      if (truthy(value)) BugContest.start(save); else BugContest.stop(save);
      return;
    }
    const badge = FieldMoves.BADGE_FLAG[flag];
    if (truthy(badge) && truthy(save)) {
      save.player = save.player ?? {};
      save.player[badge.store] = save.player[badge.store] ?? {};
      if (truthy(value)) save.player[badge.store][badge.name] = true;
      else delete save.player[badge.store][badge.name];
      return;
    }
    // InitGender is the only writer on the cart; this keeps a stray setflag
    // out of save.engineFlags (../pokecrystal/engine/menus/init_gender.asm:23-42).
    if (flag === FieldMoves.FEMALE_FLAG && truthy(save)) {
      save.player = save.player ?? {};
      save.player.gender = truthy(value) ? "female" : "male";
      return;
    }
    // The write half of the day-care aliases. DayCareManScript_Outside's
    // `clearflag ENGINE_DAY_CARE_MAN_HAS_EGG` is the ONLY cart script writing
    // any of the three, idempotent after DayCareManOutside's res
    // (engine/events/daycare.asm:393, Breeding.collectEgg). The two HAS_MON
    // bits belong to deposit/withdraw, so a script write is swallowed.
    if (truthy(save)) {
      if (flag === ENGINE.DAY_CARE_MAN_HAS_EGG) {
        Breeding.dayCare(save)!.hasEgg = truthy(value);
        return;
      } else if (flag === ENGINE.DAY_CARE_MAN_HAS_MON
          || flag === ENGINE.DAY_CARE_LADY_HAS_MON) {
        return;
      }
    }
    const flags = this.engineFlags();
    if (truthy(value)) flags[flag] = true;
    else delete flags[flag];
  }

  // Lua: World.lua:1922-1941
  // Script_writevar / Script_loadvar. VAR.BATTLETYPE is the only slot read
  // BACK out of scriptVars today (startScriptedBattle consumes it).
  // VAR.MOVEMENT is not a stored value at all: its .VarActionTable row is the
  // ADDRESS of wPlayerState, so `loadvar VAR.MOVEMENT, PLAYER_BIKE` changes the
  // player's state outright -- the whole of Script_GetOnBike.
  writeVar(varId: any, value: any): void {
    if (varId == null) return;
    this.scriptVars[varId] = value ?? 0;
    if (varId === VAR.MOVEMENT) {
      const state = PLAYER_STATE_BY_ID[value ?? 0];
      if (truthy(state)) this.applyPlayerState(state);
    }
    if (varId >= VAR.BT_WIN_STREAK && varId <= VAR.KENJI_BREAK) {
      this.setCrystalVar(varId, value);
    }
  }

  // Lua: World.lua:1943-1945
  battleType(): number {
    return this.scriptVars[VAR.BATTLETYPE] ?? 0;
  }

  // ---- W2: World.lua:1960-3556 ---------------------------------------------

  // Lua: World.lua:1960 -- Script_callasm / Script_memcallasm: a bank:address
  // into raw GB code, resolved and ported in script/CallAsm.ts. A site not in
  // its table answers nil and the VM leaves wScriptVar alone.
  callAsm(label?: any, bank?: any, addr?: any): any {
    return CallAsm.dispatch(this, label, bank, addr);
  }

  // Lua: World.lua:1972 -- Script_appear: the mirror of World:disappearObject.
  // Both halves have to come off (the event flag AND the synthetic hide the
  // flagless path wrote under the same key), or a disappear/appear pair is
  // one-way. The rebuild is immediate, because ApplyEventActionAppearDisappear
  // respawns the object struct inside the command.
  appearObject(objectId?: any): void {
    // home/map_objects.asm:309
    if (objectId === 0) {
      this.playerMasked = undefined;
      return;
    }
    const index = (objectId ?? 0) - 1;
    const def = this.map ? this.map.def : undefined;
    // object_const_def starts at 2; extracted objects are 1-based.
    const obj = def && def.objects ? def.objects[index - 1] : undefined;
    if (!obj) return;
    if (obj.eventFlag != null && obj.eventFlag !== 0xffff) {
      this.events.set(obj.eventFlag, false);
    }
    // UnmaskObject (home/map.asm:1548) clears exactly ONE byte of wObjectMasks,
    // this object's, and nothing re-reads the event flag until the next
    // LoadObjectMasks. Objects sharing one MAPOBJECT_EVENT_FLAG are ordinary
    // (the three Burned Tower beasts, maps/BurnedTowerB1F.asm:152, `appear`ed
    // one at a time), so the flag alone must not put the others on the map.
    this.setObjectMask(obj, index, false);
    // Script_appear RESPAWNS the object struct out of the MAP object
    // (UnmaskCopyMapObjectStruct -> CopyMapObjectToObjectStruct,
    // engine/overworld/player_object.asm:207-215, re-seeds X/Y), so an `appear`
    // takes the cell a preceding `moveobject` wrote. Keeping the pooled NPC left
    // Kurt at the well entrance after `moveobject SLOWPOKEWELLB1F_KURT, 11, 6`;
    // dropping it is the literal port of the respawn.
    if (this.npcPool) {
      delete this.npcPool[format("%s_obj_%d", this.map.id, obj.index ?? 0)];
    }
    this.rebuildPeople({ seamless: true });
  }

  // Lua: World.lua:2012 -- Script_moveobject: MAPOBJECT_X_COORD /
  // MAPOBJECT_Y_COORD, in plain map cells. It nearly always names an object
  // that is still HIDDEN (`moveobject` then `appear`), so the def is written
  // first and the live NPC second.
  moveObject(objectId?: any, cellX?: any, cellY?: any): void {
    const index = (objectId ?? 0) - 1;
    const def = this.map ? this.map.def : undefined;
    const obj = def && def.objects ? def.objects[index - 1] : undefined;
    if (!(obj && cellX != null && cellY != null)) return;
    const mapId = this.map ? this.map.id : undefined;
    const key = obj.index ?? index;
    if (truthy(mapId)) {
      this.objectSpawns = this.objectSpawns ?? {};
      this.objectSpawns[mapId] = this.objectSpawns[mapId] ?? {};
      if (!this.objectSpawns[mapId][key]) {
        // [x, y] (Lua `{ obj.x, obj.y }`: [1], [2] there).
        this.objectSpawns[mapId][key] = [obj.x, obj.y];
      }
    }
    obj.x = cellX;
    obj.y = cellY;
    const npc = this.objectEntity(objectId);
    if (npc && npc !== this.player) {
      npc.cellX = cellX;
      npc.cellY = cellY;
      npc.px = cellX * 16;
      npc.py = cellY * 16;
      npc.moving = false;
      npc.progress = 0;
      npc.targetX = undefined;
      npc.targetY = undefined;
      // The anim path is anchored on where the object was placed, so a
      // teleported NPC that walks a radius takes its home with it.
      npc.homeX = cellX;
      npc.homeY = cellY;
      // The `appear` beside it re-runs StepFunction_Reset, which re-reads the
      // object's own tile (engine/overworld/map_objects.asm:498-511, :196-208).
      npc.inGrass = this.grassAt(cellX, cellY);
      npc.grassShake = undefined;
    }
  }

  // Lua: World.lua:2075 -- every POOLED object whose `sprite` is the
  // SPRITE.VARS byte for `slot`, handed the sheet the slot now names: `special
  // LoadUsedSpritesGFX`, which sits beside `variablesprite` at all four call
  // sites (maps/Route36.asm:71, FuchsiaGym.asm:36 and :66,
  // CopycatsHouse2F.asm:24). Seamless connections keep neighbor objects pooled,
  // so without this the Route 37 twins (SPRITE_WEIRD_TREE) keep the
  // SPRITE_SUDOWOODO sheet they were pooled with on Route 36. The repaint is in
  // place (NPC:setSpriteDef), not a retire-and-rebuild: two call sites run
  // mid-conversation and a fresh NPC would strand talkNpc / trainerNpc /
  // followState / moveState. An emptied slot is the one case that retires.
  repaintVariableSpritePool(slot: any): void {
    if (!this.npcPool) return;
    const byte = SPRITE.VARS + slot;
    for (const key of Object.keys(this.npcPool)) {
      const npc = this.npcPool[key];
      if (npc.def && npc.def.sprite === byte) {
        const name = this.resolveSprite(byte);
        const spriteDef = (name !== null && typeof name === "object") ? name
          : (truthy(name) && this.sprites ? this.sprites[name] : undefined);
        if (truthy(spriteDef)) {
          if (truthy(npc.setSpriteDef(spriteDef))) this.applySpritePalette(npc);
        } else {
          delete this.npcPool[key];
        }
      }
    }
  }

  // Lua: World.lua:2105 -- ../pokecrystal/engine/events/battle_tower/
  // battle_tower.asm:1564-1575 writes the sprite byte into wMapObjects, the
  // LIVE copy, so the map def is untouched.
  setObjectSprite(objectId?: any, spriteName?: any): boolean {
    const npc = this.objectEntity(objectId);
    const spriteDef = truthy(spriteName) && this.sprites ? this.sprites[spriteName] : undefined;
    if (!(npc && spriteDef)) return false;
    if (truthy(npc.setSpriteDef(spriteDef))) this.applySpritePalette(npc);
    return true;
  }

  // Lua: World.lua:2113 -- Script_variablesprite: wVariableSprites[slot] =
  // sprite byte. Filling the slot puts the Sudowoodo, the Copycat, the Olivine
  // rival and the Fuchsia Gym Janines on the map at all; REFILLING it (Route 36's
  // `variablesprite SPRITE_WEIRD_TREE, SPRITE_TWIN`, maps/Route36.asm:58/:70)
  // hands the slot to the Route 37 twins, so pooled readers go with it.
  setVariableSprite(slot?: any, spriteIndex?: any): void {
    if (slot == null) return;
    this.variableSprites[slot] = spriteIndex;
    this.repaintVariableSpritePool(slot);
    this.rebuildPeople({ seamless: true });
  }

  // Lua: World.lua:2131 -- InitializeEventsScript's `variablesprite` list,
  // recovered from scripts for a cache written before the extractor recorded
  // `initial_events.sprites`. The script is found by content: the one whose
  // `setevent` ids are exactly the seed list. Lua's pairs() order is undefined
  // here; sortedKeys() makes the first match deterministic. (Lua also skipped
  // non-string keys; every JS key is a string.)
  findInitialSprites(): Array<{ slot: any; sprite: any }> {
    const wanted: Record<string, boolean> = {};
    let count = 0;
    for (const id of (this.initialEvents ?? [])) {
      if (id == null) break; // ipairs stops at the first nil
      wanted[id] = true;
      count = count + 1;
    }
    if (count === 0 || this.scripts === null || typeof this.scripts !== "object") return [];
    for (const key of sortedKeys(this.scripts)) {
      const list = this.scripts[key];
      if (list !== null && typeof list === "object") {
        let hits = 0;
        const sprites: Array<{ slot: any; sprite: any }> = [];
        for (const cmd of (Array.isArray(list) ? list : [])) {
          if (cmd !== null && typeof cmd === "object") {
            if (cmd.op === "setevent") {
              const id = cmd.event ?? (cmd.args ? cmd.args[0] : undefined);
              if (id != null && wanted[id]) hits = hits + 1;
            } else if (cmd.op === "variablesprite") {
              const args = cmd.args ?? [];
              const slot = cmd.slot ?? args[0];
              const sprite = cmd.sprite ?? args[1];
              if (slot != null && sprite != null) {
                sprites.push({ slot, sprite });
              }
            }
          }
        }
        if (hits === count && sprites.length > 0) return sprites;
      }
    }
    return [];
  }

  // Lua: World.lua:2175 -- GetMonSprite's .BreedMon1 / .BreedMon2 tail
  // (engine/overworld/overworld.asm:279-305): LoadOverworldMonIcon of the
  // deposited species. There is no sprites row, so the def is built in the
  // shape RomExtractorGen2:extractMonSprites emits for POKEMON_SPRITE rows.
  // Cached by species; rebuildPeople empties the pool on map entry, which is
  // exactly when the cart reloads the sprite (LoadMapObjects).
  breedmonSpriteDef(species: any): any {
    if (!truthy(species)) return undefined;
    this.breedmonSprites = this.breedmonSprites ?? {};
    const hit = this.breedmonSprites[species];
    if (hit != null) return truthy(hit) ? hit : undefined;
    const icons = this.game && this.game.data ? this.game.data.gen2Icons : undefined;
    const iconId = icons && icons.species ? icons.species[species] : undefined;
    const entry = iconId != null && icons.icons ? icons.icons[iconId] : undefined;
    if (!(entry && entry.image)) {
      this.breedmonSprites[species] = false;
      return undefined;
    }
    const def = {
      id: "SPRITE_DAY_CARE_MON",
      image: entry.image,
      frames: 2,
      walker: false,
      spriteType: "POKEMON_SPRITE",
      palette: "PAL_OW_RED",
      paletteId: 0,
      species: species,
      icon: iconId,
    };
    this.breedmonSprites[species] = def;
    return def;
  }

  // Lua: World.lua:2202 -- an object whose `sprite` is a SPRITE.VARS byte
  // resolves through the slot table and constants.spriteOrder (1-based in Lua,
  // `const_def 1`; the JSON array is 0-based, hence byte - 1). An unfilled slot
  // answers nil and the object does not spawn, as on the cart.
  resolveSprite(sprite: any): any {
    if (typeof sprite !== "number") return sprite;
    // GetMonSprite tests the two day-care bytes ABOVE the SPRITE.VARS range.
    // .NoBreedmon answers sprite 1 for an empty slot; nil is the honest port,
    // because the object's own event flag stays set until checkflag says a mon
    // is there (Route34EggCheckCallback).
    if (sprite === SPRITE.DAY_CARE_MON_1 || sprite === SPRITE.DAY_CARE_MON_2) {
      const save = this.game ? this.game.save : undefined;
      const slot = save ? Breeding.side(save,
        sprite === SPRITE.DAY_CARE_MON_1 ? "man" : "lady") : undefined;
      const mon = slot ? slot.mon : undefined;
      return mon ? (this.breedmonSpriteDef(mon.species) ?? undefined) : undefined;
    }
    if (sprite < SPRITE.VARS) return undefined;
    const byte = this.variableSprites[sprite - SPRITE.VARS];
    if (!truthy(byte) || byte === 0) return undefined;
    const order = this.constants ? this.constants.spriteOrder : undefined;
    return order ? (order[byte - 1] ?? undefined) : undefined;
  }

  // Lua: World.lua:2228 -- Script_changeblock. The VM has already halved the
  // cell coords into block coords; replaceBlock is the same buffer edit CUT and
  // WHIRLPOOL make, undone by the next LoadMapAttributes (restoreBlocks). The
  // index passed is Lua's 1-based flat index, as every replaceBlock caller has.
  changeBlock(blockX?: any, blockY?: any, blockId?: any): any {
    const map = this.map;
    if (!(map && blockX != null && blockY != null && blockId != null)) return false;
    if (blockX < 0 || blockY < 0 || blockX >= map.width || blockY >= map.height) {
      return false;
    }
    return this.replaceBlock(blockY * map.width + blockX + 1, blockId);
  }

  // Lua: World.lua:2246 -- resolve a raw ROM blockdata pointer (bank + address,
  // as a `dba` writes into wMapBlocksBank / wMapBlocksPointer) to the blocks a
  // cache holds: each map's def.blockdata names its own array, and the pointer
  // is found by the array it lands IN (it may sit part way through one).
  // Returns [blocks, offset] (Lua's two results; offset is 0-based) or
  // undefined. Lua walks pairs(self.maps); sortedKeys() fixes the order.
  blockdataAt(bank?: any, address?: any): [any[], number] | undefined {
    if (bank == null || address == null) return undefined;
    const maps = this.maps ?? {};
    for (const id of sortedKeys(maps)) {
      const def = maps[id];
      const bd = def.blockdata;
      if (bd && bd.bank === bank && bd.address != null && def.blocks
          && address >= bd.address && address < bd.address + def.blocks.length) {
        return [def.blocks, address - bd.address];
      }
    }
    return undefined;
  }

  // Lua: World.lua:2275 -- Script_changemapblocks: a `dba` into
  // wMapBlocksBank / wMapBlocksPointer, then ChangeMap and BufferScreen.
  // ChangeMap refills the WHOLE buffer, wMapWidth x wMapHeight bytes read as
  // one flat run off the pointer. The edits are recorded the way replaceBlock
  // records a CUT (keyed by Lua's 1-based flat index) so restoreBlocks undoes
  // them; BufferScreen is refreshMapImages. An unplaceable pointer or a run off
  // the end of the source array is a no-op. Nothing in pokegold reaches it.
  changeMapBlocks(bank?: any, address?: any): boolean {
    const map = this.map;
    const blocks = map && map.def ? map.def.blocks : undefined;
    if (!(map && blocks && truthy(map.width) && truthy(map.height))) return false;
    const found = this.blockdataAt(bank, address);
    if (!found) return false;
    const [src, offset] = found;
    const count = map.width * map.height;
    if (offset + count > src.length) return false;
    // Read the run out first: the pointer may name the loaded map's own
    // blockdata, and an in-place copy would overwrite bytes it still reads.
    const run: any[] = [];
    for (let i = 1; i <= count; i++) run[i] = src[offset + i - 1];
    let edits = this.blockEdits[map.id];
    if (!edits) {
      edits = {};
      this.blockEdits[map.id] = edits;
    }
    for (let i = 1; i <= count; i++) {
      if (edits[i] == null) edits[i] = blocks[i - 1];
      blocks[i - 1] = run[i];
    }
    map.blocks = blocks;
    this.refreshMapImages();
    return true;
  }

  // Lua: World.lua:2311 -- Script_earthquake -> ShakeScreen. ONE byte carries
  // two numbers (MovementFunction_ScreenShake .GetDurationAndField1e): the low
  // six bits are the duration in frames, the top two pick an amplitude of
  // 1 << bits, added to / subtracted from wPlayerStepVectorY on alternate
  // frames. `earthquake 80` ($50) is two pixels for sixteen frames. Starts the
  // shake and returns at once: the VM holds the script for the frames itself.
  // State only: the renderer reads this.shake.phase as the Y offset.
  earthquake(displacement?: any, frames?: any): void {
    const byte = displacement ?? 0;
    const amplitude = 2 ** mod(Math.floor(byte / 64), 4);
    this.shake = { left: frames ?? mod(byte, 64), amplitude: amplitude, phase: 0 };
  }

  // Lua: World.lua:2317
  updateShake(): void {
    const shake = this.shake;
    if (!shake) return;
    shake.left = shake.left - 1;
    if (shake.left <= 0) {
      this.shake = undefined;
      return;
    }
    // `.GetSign`: the offset flips with the parity of the frames left.
    shake.phase = (mod(shake.left, 2) === 0) ? shake.amplitude : -shake.amplitude;
  }

  // Lua: World.lua:2333
  startSkyfall(): void {
    this.playSfxNamed("Sfx_Kinesis", SFX.KINESIS);
    this.skyfall = { phase: "hidden", timer: SKYFALL_BEAT_FRAMES, height: 0 };
    this.playerMasked = true;
  }

  // Lua: World.lua:2339
  updateSkyfall(): void {
    const st = this.skyfall;
    if (!st) return;
    if (st.phase === "hidden") {
      st.timer = st.timer - 1;
      if (st.timer > 0) return;
      // engine/overworld/map_objects.asm:1390-1402
      st.phase = "fall";
      st.timer = SKYFALL_BEAT_FRAMES;
      this.playerMasked = undefined;
    }
    st.height = st.height + 1;
    if (this.player) {
      this.player.spriteYOffset = Movement.teleportYOffset(st.height);
    }
    st.timer = st.timer - 1;
    if (st.timer > 0) return;
    if (this.player) this.player.spriteYOffset = 0;
    this.skyfall = undefined;
    this.playSfxNamed("Sfx_Strength", SFX.STRENGTH);
    this.earthquake(PITFALL_EARTHQUAKE);
  }

  // Lua: World.lua:2363 -- engine/events/poisonstep_pals.asm:9. State only:
  // the counter is what the renderer (and its decrementer) read.
  poisonBGFlash(): void {
    this.poisonFlash = 4;
  }

  // Lua: World.lua:2378 -- Script_warp / Script_warpfacing: a raw destination
  // CELL, distinct from the warp_events World:takeWarp follows. `facing` is nil
  // for `warp` and a direction for `warpfacing`. An unresolvable group/map pair
  // is a silent no-op. MAPSETUP.WARP opens on DisableLCD, not a fade out; a
  // `warpfacing` byte is PLAYERSPRITESETUP_CUSTOM_FACING, applied INSTEAD of
  // SpawnInFacingDown, so a custom facing skips World:spawnFacing.
  warpTo(group?: any, mapNum?: any, cellX?: any, cellY?: any, facing?: any): any {
    const mapId = this.mapIdByGroupMap(group, mapNum);
    if (!truthy(mapId)) return false;
    return this.warpToMapId(mapId, cellX, cellY, facing);
  }

  // Lua: World.lua:2388 -- the same warp addressed by map id (mods'
  // world:warpTo and anything holding a maps[] key), one body for both.
  warpToMapId(mapId?: any, cellX?: any, cellY?: any, facing?: any): any {
    if (!(truthy(mapId) && cellX != null && cellY != null)) return false;
    return this.runMapSetup(MAPSETUP.WARP, () => {
      const ok = this.setMap(mapId, cellX, cellY,
        or_W2(facing, this.player ? this.player.facing : undefined, "down"));
      if (truthy(ok) && !truthy(facing)) this.spawnFacing();
      return ok;
    });
  }

  // Lua: World.lua:2409 -- Script_warp's group-0 arm, `warp NONE, 0, 0`:
  // MAPSETUP.BADWARP is a full load of the map the player is standing on
  // (HandleNewMap, LoadBlockData, LoadMapObjects), which is what
  // PlayersHousePCScript's `.Warp` needs to move the bedroom decorations.
  // `reason` doubles as the map.reloaded emit gate (WorldAPI's invalidateMap
  // calls this with none and raises the event itself).
  reloadMapBadWarp(reason?: any): any {
    const map = this.map;
    const p = this.player;
    if (!(map && p)) return false;
    const mapId = map.id;
    const cx = p.cellX, cy = p.cellY, facing = p.facing;
    const ok = this.runMapSetup(MAPSETUP.BADWARP, () => {
      return this.setMap(mapId, cx, cy, facing);
    });
    if (truthy(ok) && truthy(reason)) {
      Runtime.emit("map.reloaded", { mapId: mapId, reason: reason });
    }
    return ok;
  }

  // Lua: World.lua:2427 -- Script_warpcheck -> WarpCheck. It does NOT warp: it
  // notices the player is on a warp tile and lets the overworld loop take it
  // once the script is done.
  armWarpCheck(): boolean {
    const p = this.player;
    if (!(this.map && p)) return false;
    const entry = this.map.warpAt(p.cellX, p.cellY);
    if (!entry) return false;
    this.pendingWarp = entry.def;
    return true;
  }

  // Lua: World.lua:2440 -- the drain, from World:step. Gated on the SCRIPT, not
  // World:busy: the cart takes the warp the moment the script ends.
  takePendingWarp(): any {
    const warp = this.pendingWarp;
    if (!warp) return false;
    this.pendingWarp = undefined;
    return this.takeWarp(warp);
  }

  // Lua: World.lua:2460 -- play an sfx by its pokegold LABEL, falling back to
  // the index this cache had when the constant was written. Lua's `i - 1` over
  // a 1-based sfxOrder is the 0-based JSON index.
  sfxIdNamed(want?: any, fallbackId?: any): any {
    const audio = this.game && this.game.data ? this.game.data.audio : undefined;
    const order = audio ? audio.sfxOrder : undefined;
    let id = fallbackId;
    if (order && truthy(want)) {
      for (let i = 0; i < order.length; i++) {
        const name = order[i];
        if (name == null) break; // ipairs
        if (name === want) { id = i; break; }
      }
    }
    return id;
  }

  // Lua: World.lua:2472
  playSfxNamed(want?: any, fallbackId?: any): void {
    this.playSfx(this.sfxIdNamed(want, fallbackId));
  }

  // Lua: World.lua:2478 -- .BumpSound (engine/overworld/player_movement.asm:771),
  // CheckSFX at home/audio.asm:477
  bumpSound(): void {
    if (truthy(Sound.sfxBusy())) return;
    this.playSfxNamed("Sfx_Bump", SFX.BUMP);
  }

  // Lua: World.lua:2491 -- Script_specialsound (engine/overworld/
  // scripting.asm:476) farcalls CheckItemPocket (engine/items/items.asm:512)
  // and rings SFX.GET_TM for the TM/HM pocket, SFX.ITEM for every other. It is
  // the sound inside GiveItemScript, so every `verbosegiveitem` runs through
  // it. An item the cache cannot name falls through to SFX.ITEM.
  specialSound(itemIndex?: any): void {
    // The `waitsfx` above it (scripting.asm:445): SFX_READ_TEXT_2 ($08) the box
    // rings on its own press outranks SFX_GET_TM ($9b) here (#1483).
    Sound.waitSfxDone();
    const id = truthy(itemIndex) ? this.itemIdByIndex(itemIndex) : undefined;
    const items = this.game && this.game.data ? this.game.data.items : undefined;
    const def = id != null && items ? items[id] : undefined;
    if (def && def.pocket === "TM_HM") {
      this.playSfxNamed("Sfx_GetTm", SFX.GET_TM);
    } else {
      this.playSfxNamed("Sfx_Item", SFX.ITEM);
    }
  }

  // Lua: World.lua:2505
  warpSound(): void {
    const p = this.player;
    if (!(this.map && p)) return;
    Sound.dropPressSfx();
    const coll = this.map.cellCollision(p.cellX, p.cellY);
    let id = SFX.EXIT_BUILDING;
    if (coll === COLL.DOOR) {
      id = SFX.ENTER_DOOR;
    } else if (coll === COLL.WARP_PANEL) {
      id = SFX.WARP_TO;
    }
    this.playSfxNamed(WARP_SFX_NAME[id], id);
  }

  // Lua: World.lua:2557 -- Script_newloadmap: hMapEntryMethod, then
  // MAPSTATUS_ENTER on the CURRENT map; the reload is a setMap onto the cell
  // the player stands on, wrapped in the setup script the MAPSETUP_* byte
  // picks. It plays NO sound (the cart writes a separate `warpsound`).
  // A load a `warpcheck` armed goes to the DESTINATION (MapSetupScript_Train's
  // EnterMapWarp / GetWarpDestCoords): that pairing is the Magnet Train and
  // nothing else. _Train has no SpawnInFacingDown, so the player keeps facing
  // the way they boarded. The arrival cell is the destination warp_event's own
  // (11,5); the coord_event at (11,6) is reached by the one forced step south,
  // as on the cart. Locked by tests/gen2_magnet_train_test.lua.
  // resolveWarp returns [destMapId, destWarpNumber] (Lua's two results); the
  // warp number is 1-based, the JSON warps array 0-based.
  newLoadMap(method?: any): any {
    const p = this.player;
    if (!(this.map && p)) return false;
    const armed = this.pendingWarp;
    if (armed) {
      this.pendingWarp = undefined;
      const [destMapId, destWarpNumber] = this.resolveWarp(armed);
      const dest = this.maps[destMapId];
      const destWarp = dest && dest.warps ? dest.warps[destWarpNumber - 1] : undefined;
      if (destWarp) {
        this.backupMapId = this.map.id;
        // CopyWarpData ran when `warpcheck` found the player on the tile, so
        // this take carries the same wPrevWarp bookkeeping as a walked warp.
        const prevMapId = this.map.id;
        const prevWarpIndex = this.warpIndexOf(armed);
        return this.runMapSetup(method, () => {
          const ok = this.setMap(destMapId, destWarp.x, destWarp.y, p.facing);
          if (truthy(ok)) {
            this.recordWarpBackup(prevMapId, prevWarpIndex, destWarp, destMapId);
          }
          return ok;
        });
      }
    }
    return this.runMapSetup(method, () => {
      return this.setMap(this.map.id, p.cellX, p.cellY, p.facing);
    });
  }

  // Lua: World.lua:2590 -- Script_warpmod: wBackupWarpNumber / wBackupMapGroup
  // / wBackupMapNumber, where the game believes you came IN from.
  setWarpMod(warpId?: any, group?: any, mapNum?: any): void {
    const save = this.game ? this.game.save : undefined;
    if (!save) return;
    save.warpMod = {
      warp: warpId,
      map: this.mapIdByGroupMap(group, mapNum),
      group: group, mapNumber: mapNum,
    };
  }

  // Lua: World.lua:2604 -- Script_blackoutmod: wLastSpawnMapGroup /
  // wLastSpawnMapNumber (the S.S. Aqua, Mr. Pokemon's house). warpToSpawn
  // prefers it over the SPAWN_* lookup, and it survives a save.
  setBlackoutMap(group?: any, mapNum?: any): void {
    const save = this.game ? this.game.save : undefined;
    if (!save) return;
    save.blackoutMap = this.mapIdByGroupMap(group, mapNum);
  }

  // Lua: World.lua:2614 -- Script_swarm -> StoreSwarmMapIndices, which FALLS
  // THROUGH into SetSwarmFlag: the map pair and DAILYFLAGS1_SWARM together.
  setSwarm(group?: any, mapNum?: any, kind?: any): void {
    const save = this.game ? this.game.save : undefined;
    if (!save) return;
    Roamers.Swarm.set(save, this.mapIdByGroupMap(group, mapNum), kind);
  }

  // Lua: World.lua:2622 -- Script_loadwildmon's other half: roll the CURRENT
  // map's own table the way a step would. nil is fine.
  rollWild(): any {
    const map = this.map;
    if (!(map && this.encounters && this.player)) return undefined;
    // Script_randomwildmon only clears wBattleScriptFlags; RockMonEncounter is
    // the one routine that writes wTempWildMonSpecies ahead of it (from
    // TREEMON_SET_ROCK), so its mon is consumed here rather than rolled over.
    const pending = this.tempWildMon;
    this.tempWildMon = undefined;
    if (pending) return pending;
    const tables = this.wildTables();
    const collision = map.cellCollision(this.player.cellX, this.player.cellY);
    const onWater = FieldMoves.encounterTable(collision) === "water";
    // kind "script": a `randomwildmon` the VM asked for, not a step's roll.
    const roll = this.rollEncounter("script", onWater ? "water" : "grass",
      tables, onWater ? rollWaterVanilla : rollGrassVanilla);
    if (!roll) return undefined;
    // The encounter tables name a species by ID; `loadwildmon` is a SPECIES
    // INDEX, so the roll is translated here.
    const pokemon = this.game && this.game.data ? this.game.data.pokemon : undefined;
    const def = pokemon ? pokemon[roll.species] : undefined;
    if (!(def && def.index != null)) return undefined;
    return { species: def.index, level: roll.level };
  }

  // Lua: World.lua:2650 -- GetMapMusic (home/map.asm:2550). musicOrder is
  // 1-based in Lua (`+ 1`), 0-based in the JSON.
  static mapMusicLabel(audio: any, musicByte: any, rocketsMahogany?: any, rocketsRadioTower?: any): string | undefined {
    if (typeof musicByte !== "number") return undefined;
    const MUSIC_MAHOGANY_MART = 100; // constants/music_constants.asm:100
    const RADIO_TOWER_MUSIC = 0x80; // constants/music_constants.asm:109
    const order = audio ? audio.musicOrder : undefined;
    const songs = audio ? audio.songs : undefined;
    let label: any;
    if (musicByte === MUSIC_MAHOGANY_MART) {
      label = truthy(rocketsMahogany) ? "Music_RocketHideout" : "Music_CherrygroveCity";
    } else if (musicByte >= RADIO_TOWER_MUSIC) {
      label = truthy(rocketsRadioTower) ? "Music_RocketTheme"
        : (order ? order[musicByte - RADIO_TOWER_MUSIC] : undefined);
    } else {
      return undefined;
    }
    if (truthy(label) && label !== "Music_Nothing" && songs && songs[label]) {
      return label;
    }
    return undefined;
  }

  // Lua: World.lua:2671
  mapMusicSong(mapId: any): string | undefined {
    const audio = this.game && this.game.data ? this.game.data.audio : undefined;
    const def = this.maps ? this.maps[mapId] : undefined;
    // ENGINE_ROCKETS_IN_MAHOGANY / _RADIO_TOWER (data/events/engine_flags.asm:40,:36)
    return World.mapMusicLabel(audio, def ? def.music : undefined,
      this.engineFlag(22), this.engineFlag(18));
  }

  // Lua: World.lua:2679
  playMapMusic(): void {
    const data = this.game ? this.game.data : undefined;
    if (data && data.audio && data.audio.runtime && this.map) {
      // SpecialMapMusic (home/audio.asm:397)
      Music.playMap(data, this.map.id, undefined,
                    FieldMoves.isSurfing(this.playerState), undefined,
                    this.mapMusicSong(this.map.id));
    }
  }

  // Lua: World.lua:2693 -- data/maps/setup_scripts.asm:48, :117;
  // home/audio.asm:335, :281; engine/overworld/events.asm:993
  setMapMusic(mapId?: any, seamless?: any, method?: any): void {
    const data = this.game ? this.game.data : undefined;
    const audio = data ? data.audio : undefined;
    if (!(audio && audio.runtime)) return;
    method = or_W2(method, this.setupMethod, MAPSETUP.WARP);
    const bikeRow = (!truthy(seamless) && MAPSETUP_MUSIC_BIKE[method]) || false;
    const bike = bikeRow
      && truthy(FieldMoves.isBiking(this.playerState))
      && this.playBikeMusic();
    if (truthy(bike)) return;
    Music.playMap(data, mapId, undefined,
                  FieldMoves.isSurfing(this.playerState),
                  !bikeRow ? Music.MAP_FADE : undefined,
                  this.mapMusicSong(mapId));
  }

  // Lua: World.lua:2711 -- home/audio.asm:379, :281
  restoreMapMusic(): void {
    const data = this.game ? this.game.data : undefined;
    if (!data) return;
    // engine/events/overworld.asm:1627
    const reason = truthy(FieldMoves.isBiking(this.playerState)) ? "bike" : undefined;
    Music.restoreMap(data, reason);
  }

  // Lua: World.lua:2728 -- ForceMapMusic (engine/overworld/map_setup.asm:201),
  // the music row every MapSetupScript_ReloadMap ends on, and
  // TryRestartMapMusic (home/audio.asm:366) under it. wDontPlayMapMusicOnReload
  // is consumed HERE, at the reload (`startbattle / dontrestartmapmusic /
  // reloadmap`, maps/CherrygroveCity.asm:124): set, the cart plays MUSIC_NONE,
  // zeroes wMapMusic and clears the flag.
  forceMapMusic(): void {
    if (truthy(this.dontRestartMusic)) {
      this.dontRestartMusic = false;
      Music.setMapSong(null); // `xor a / ld [wMapMusic], a`
      Music.stop();
      return;
    }
    this.restoreMapMusic();
  }

  // Lua: World.lua:2747 -- Script_musicfadeout: the ramp, then the song under
  // it. `fade` is frames per volume step; musicId 0 (MUSIC_NONE) fades to
  // silence. Music.fadeOut steps level 7 -> 0 one notch every `control`
  // frames, so the queued label starts control * 7 frames later (counted here).
  fadeOutMusic(musicId?: any, fadeControl?: any): void {
    const control = Math.max(1, fadeControl ?? 10);
    Music.fadeOut(control);
    const data = this.game ? this.game.data : undefined;
    const audio = data ? data.audio : undefined;
    const order = audio ? audio.musicOrder : undefined;
    const name = order ? order[musicId ?? 0] : undefined;
    if (truthy(name) && name !== "Music_Nothing" && audio.songs && audio.songs[name]) {
      this.pendingMusic = { name: name, left: control * 7 };
    } else {
      this.pendingMusic = undefined;
    }
  }

  // Lua: World.lua:2764 -- the fade's tail, ticked from World:step: the queued
  // song starts the frame the ramp reaches the bottom.
  updateMusicFade(): void {
    const pending = this.pendingMusic;
    if (!pending) return;
    pending.left = pending.left - 1;
    if (pending.left > 0) return;
    this.pendingMusic = undefined;
    const data = this.game ? this.game.data : undefined;
    if (data) {
      Music.play(data, pending.name, true, { reason: "script_fadeout" });
    }
  }

  // Lua: World.lua:2777 -- `checkitem` and `takeitem`, over the same Bag the
  // PACK reads.
  itemIdByIndex(itemIndex: any): string | undefined {
    const items = this.game && this.game.data ? this.game.data.items : undefined;
    return itemByIndex(items, itemIndex)[0];
  }

  // Lua: World.lua:2782
  hasItem(itemIndex?: any): boolean {
    const save = this.game ? this.game.save : undefined;
    const id = this.itemIdByIndex(itemIndex);
    if (!(save && id)) return false;
    return (save.inventory && (save.inventory[id] ?? 0) > 0) || false;
  }

  // Lua: World.lua:2789
  takeItem(itemIndex?: any, qty?: any): boolean {
    const save = this.game ? this.game.save : undefined;
    const id = this.itemIdByIndex(itemIndex);
    if (!(save && id)) return false;
    save.inventory = save.inventory ?? {};
    const have = save.inventory[id] ?? 0;
    qty = qty ?? 1;
    // TossItem takes nothing at all when the pack holds fewer than asked.
    if (have < qty) return false;
    const left = have - qty;
    if (left > 0) save.inventory[id] = left;
    else delete save.inventory[id];
    return true;
  }

  // Lua: World.lua:2805 -- YOUR_MONEY 0 / MOMS_MONEY 1 (constants/
  // script_constants.asm). The VM does the 0..999999 clamp.
  money(account?: any): number {
    const save = this.game ? this.game.save : undefined;
    if (!save) return 0;
    if ((account ?? 0) === 1) {
      return (save.mom ? save.mom.savedMoney : undefined) ?? 0;
    }
    return (save.player ? save.player.money : undefined) ?? 0;
  }

  // Lua: World.lua:2814
  setMoney(account?: any, value?: any): void {
    const save = this.game ? this.game.save : undefined;
    if (!save) return;
    if ((account ?? 0) === 1) {
      save.mom = save.mom ?? {};
      save.mom.savedMoney = value ?? 0;
      return;
    }
    save.player = save.player ?? {};
    save.player.money = value ?? 0;
  }

  // Lua: World.lua:2826
  coins(): number {
    const save = this.game ? this.game.save : undefined;
    return (save && save.player ? save.player.coins : undefined) ?? 0;
  }

  // Lua: World.lua:2831
  setCoins(value?: any): void {
    const save = this.game ? this.game.save : undefined;
    if (!save) return;
    save.player = save.player ?? {};
    save.player.coins = value ?? 0;
  }

  // Lua: World.lua:2840 -- `checkpoke`: the PARTY only.
  hasPoke(speciesIndex?: any): boolean {
    const save = this.game ? this.game.save : undefined;
    const [id] = speciesByIndex(
      this.game && this.game.data ? this.game.data.pokemon : undefined, speciesIndex);
    if (!(save && id)) return false;
    for (const mon of (save.party ?? [])) {
      if (mon.species === id) return true;
    }
    return false;
  }

  // Lua: World.lua:2855 -- `giveegg`: built and marked the way Breeding marks
  // a Day-Care egg, so the ODD_EGG and the Togepi egg hatch through DoEggStep
  // like any other. False when the party is full.
  giveEgg(speciesIndex?: any, level?: any): boolean {
    const data = this.game ? this.game.data : undefined;
    const save = this.game ? this.game.save : undefined;
    if (!(data && save)) return false;
    save.party = save.party ?? [];
    if (save.party.length >= Breeding.PARTY_SIZE) return false;
    const [id, def] = speciesByIndex(data.pokemon, speciesIndex);
    if (!id) return false;
    const mon = Mon.new(data, id, level ?? Breeding.EGG_LEVEL);
    if (!mon) return false;
    mon.isEgg = true;
    // `ld de, String_Egg / call CopyName2` (engine/pokemon/move_mon.asm:1193).
    mon.nickname = Breeding.EGG_NAME;
    // DayCare_InitBreeding's `ld [hl], EGG_STEPS`; DayCare_GiveEgg zeroes HP.
    mon.eggSteps = (def ? def.eggSteps : undefined) ?? 0;
    mon.hp = 0;
    // GiveEgg goes through TryAddMonToParty too (move_mon.asm:1121-1139).
    Mon.stampOT(save, mon);
    save.party.push(mon);
    return true;
  }

  // Lua: World.lua:2882 -- `landmarktotext`: the town-map name, newline and all.
  landmarkName(): string | undefined {
    const id = this.currentLandmarkId();
    const entry = truthy(id) && this.landmarks && this.landmarks.landmarks
      ? this.landmarks.landmarks[id!] : undefined;
    return (entry ? entry.name : undefined) ?? undefined;
  }

  // Lua: World.lua:2899 -- the fruit trees. FruitTreeItems is not extracted,
  // so the table lives in core/Apricorns; this turns its item ids into the
  // indices the script side speaks. FRUITTREE_* is 1-based and passed as is.
  fruitTreeItem(treeId?: any): number {
    const id = Apricorns.treeFruit(treeId);
    const items = this.game && this.game.data ? this.game.data.items : undefined;
    const def = id != null && items ? items[id] : undefined;
    return (def ? def.index : undefined) ?? 0;
  }

  // Lua: World.lua:2911 -- callasm TryResetFruitTrees, at the top of
  // FruitTreeScript.
  fruitTreeReset(): any {
    const save = this.game ? this.game.save : undefined;
    if (!save) return false;
    return Apricorns.tryResetFruitTrees(save);
  }

  // Lua: World.lua:2917
  fruitTreePicked(treeId?: any): any {
    const save = this.game ? this.game.save : undefined;
    if (!save) return false;
    const picked = Apricorns.treePicked(save, treeId);
    return truthy(picked) ? picked : false;
  }

  // Lua: World.lua:2922
  fruitTreePick(treeId?: any): void {
    const save = this.game ? this.game.save : undefined;
    if (!(save && treeId != null)) return;
    Apricorns.pickTree(save, treeId);
  }

  // Lua: World.lua:2931 -- `askforphonenumber`. _CheckCellNum returns the same
  // carry for "already stored" as for "full", so both refusals are false.
  addPhoneNumber(contact?: any): boolean {
    const save = this.game ? this.game.save : undefined;
    if (!(save && contact != null)) return false;
    if (truthy(Phone.hasContact(save, contact))) return false;
    return truthy(Phone.addContact(save, contact));
  }

  // Lua: World.lua:2941 -- `specialphonecall` / `checkphonecall`:
  // wSpecialPhoneCallID, which the next Phone.checkSpecialCall consumes.
  setSpecialCall(id?: any): void {
    const save = this.game ? this.game.save : undefined;
    if (!save) return;
    if ((id ?? 0) === Phone.SPECIALCALL_NONE) {
      Phone.clearSpecialCall(save);
    } else {
      Phone.queueSpecialCall(save, id);
    }
  }

  // Lua: World.lua:2952
  specialCall(): any {
    const save = this.game ? this.game.save : undefined;
    if (!save) return 0;
    const v = Phone.specialCallVar(save);
    return truthy(v) ? v : 0;
  }

  // ---- the specials' world half ---------------------------------------------
  // Lua: World.lua:2958-2965 -- script/Specials.ts is the other half: every
  // handler there is the cart routine, and everything it cannot do without the
  // game (a screen, the save, the party) is a call into here.

  // Lua: World.lua:2970 -- FadeToMenu / ExitAllMenus wrap a dozen specials. A
  // screen id not registered in Screens must not take the game down: an
  // unknown id is a no-op that answers false (Lua: pcall(Screens.push, ...)).
  pushScreen(id: any, opts?: any): boolean {
    const game = this.game;
    if (!(game && game.stack)) return false;
    try {
      Screens.push(game, id, opts);
      return true;
    } catch (_e) {
      return false;
    }
  }

  // Lua: World.lua:2982 -- SelectMonFromParty (engine/pokemon/party_menu.asm),
  // the blocking list a dozen specials share. `onDone(index, mon)` with nil for
  // the B press, the shape the ASM's carry flag has.
  selectPartyMon(prompt?: any, onDone?: OnDone_W2): boolean {
    const game = this.game;
    const save = game ? game.save : undefined;
    if (!(game && game.stack && save && save.party && save.party.length > 0)) {
      if (onDone) onDone(undefined);
      return false;
    }
    let finished = false;
    const finish = (index: any, mon: any) => {
      if (finished) return;
      finished = true;
      game.stack.pop();
      if (onDone) onDone(index, mon);
    };
    const ok = this.pushScreen("Gen2PartyMenu", {
      save: save,
      party: save.party,
      prompt: or_W2(prompt, "choose"),
      onChoose: (index: any, mon: any) => finish(index, mon),
      onCancel: () => finish(undefined, undefined),
    });
    if (!ok) {
      if (onDone) onDone(undefined);
      return false;
    }
    return true;
  }

  // Lua: World.lua:3020 -- GivePokeMail (engine/pokemon/mail.asm): the letter is
  // hung on the LAST party member, the one the `givepoke` before it added. One
  // call site (RandyScript, maps/Route35GoldenrodGate.asm). A raw pointer word
  // from an older cache gives nothing.
  givePokeMail(mail?: any): any {
    const save = this.game ? this.game.save : undefined;
    if (!(save && mail !== null && typeof mail === "object" && truthy(mail.item))) return false;
    return Mail.give(save, mail.item, mail.message);
  }

  // Lua: World.lua:3035 -- CheckPokeMail (engine/pokemon/mail.asm): the party
  // list, the five-way answer, and on POKEMAIL_CORRECT the mon leaving. Backing
  // out is REFUSED. The resume is guarded: selectPartyMon answers onDone(nil)
  // AND returns false when it cannot open a list at all.
  checkPokeMail(mail?: any, onDone?: OnDone_W2): void {
    const save = this.game ? this.game.save : undefined;
    const expected = (mail !== null && typeof mail === "object") ? mail.message : undefined;
    let answered = false;
    const answer = (value: any) => {
      if (answered) return;
      answered = true;
      if (onDone) onDone(value);
    };
    if (!save) return answer(Mail.POKEMAIL_REFUSED);
    const ok = this.selectPartyMon("choose", (index: any) => {
      answer(Mail.checkPokeMail(save, index, expected));
    });
    if (!ok) answer(Mail.POKEMAIL_REFUSED);
  }

  // Lua: World.lua:3058 -- the Day-Care conversation, all three doors. The
  // model is core/Breeding, the screen ui/DayCareMenu; the scriptVar the
  // outside man's branch answers with rides back through onDone.
  dayCare(side?: any, onDone?: OnDone_W2): boolean {
    const game = this.game;
    if (!(game && game.stack)) {
      if (onDone) onDone(0);
      return false;
    }
    let finished = false;
    const finish = (scriptVar?: any) => {
      if (finished) return;
      finished = true;
      game.stack.pop();
      if (onDone) onDone(scriptVar ?? 0);
    };
    const ok = this.pushScreen("Gen2DayCareMenu", {
      save: game.save,
      side: side,
      // text carries the whole Day-Care block, seeded by name.
      text: this.text,
      onClose: finish,
    });
    if (!ok) {
      if (onDone) onDone(0);
      return false;
    }
    return true;
  }

  // Lua: World.lua:3089 -- ChooseMoveToDelete (engine/pokemon/mon_menu.asm),
  // the Blackthorn move deleter's list. Hands back a 1-based slot or nil for B.
  chooseMoveToDelete(mon?: any, onDone?: OnDone_W2): boolean {
    const game = this.game;
    if (!(game && game.stack)) {
      if (onDone) onDone(undefined);
      return false;
    }
    let finished = false;
    const finish = (index: any) => {
      if (finished) return;
      finished = true;
      game.stack.pop();
      if (onDone) onDone(index);
    };
    const ok = this.pushScreen("Gen2MoveDeleter", {
      mon: mon,
      moves: game.data ? game.data.moves : undefined,
      onChoose: (index: any) => finish(index),
      onCancel: () => finish(undefined),
    });
    if (!ok) {
      if (onDone) onDone(undefined);
      return false;
    }
    return true;
  }

  // Lua: World.lua:3121 -- Mom_SetUpWithdrawMenu / _DepositMenu /
  // Mom_WithdrawDepositMenuJoypad (engine/events/mom.asm), the six-digit money
  // keypad. `onDone(amount)` gets 0..999999 or nil for B; H.BankOfMom turns it
  // into the GiveMoney/TakeMoney pair.
  bankOfMomAmount(kind?: any, saved?: any, held?: any, onDone?: OnDone_W2): boolean {
    const game = this.game;
    if (!(game && game.stack)) {
      if (onDone) onDone(undefined);
      return false;
    }
    let finished = false;
    const finish = (amount: any) => {
      if (finished) return;
      finished = true;
      game.stack.pop();
      if (onDone) onDone(amount);
    };
    const ok = this.pushScreen("Gen2BankOfMom", {
      kind: kind,
      saved: saved,
      held: held,
      onDone: (amount: any) => finish(amount),
      onCancel: () => finish(undefined),
    });
    if (!ok) {
      if (onDone) onDone(undefined);
      return false;
    }
    return true;
  }

  // Lua: World.lua:3158 -- SetDayOfWeek's wheel (ui/InitClock day mode).
  // `onDone(day)` is the special's own resume: the screen's close restarts the
  // script. (The Name Rater comment above it in the Lua belongs to renameMon.)
  setDayOfWeek(onDone?: OnDone_W2): boolean {
    const game = this.game;
    if (!(game && game.stack)) {
      if (onDone) onDone(undefined);
      return false;
    }
    const ok = this.pushScreen("Gen2InitClock", {
      mode: "day",
      save: game.save,
      onDone: (day: any) => {
        game.stack.pop();
        if (onDone) onDone(day);
      },
    });
    if (!ok && onDone) onDone(undefined);
    return ok;
  }

  // Lua: World.lua:3180 -- the rename half of the Goldenrod NAME RATER
  // (engine/events/name_rater.asm): the keyboard's header is the species name
  // (GetBaseData / _NamingScreen). `opts.blank` is the fresh-catch entry, which
  // opens empty; the Name Rater's opens on the name it replaces. `onDone(name)`
  // gets the typed string or nil for B.
  renameMon(mon?: any, onDone?: OnDone_W2, opts?: any): boolean {
    const game = this.game;
    if (!(game && game.stack && mon)) {
      if (onDone) onDone(undefined);
      return false;
    }
    let finished = false;
    const finish = (name: any) => {
      if (finished) return;
      finished = true;
      game.stack.pop();
      if (onDone) onDone(name);
    };
    const ok = this.pushScreen("Gen2NamingScreen", {
      type: "nickname",
      monName: or_W2(mon.name, mon.species),
      initial: (opts && truthy(opts.blank)) ? ""
        : or_W2(mon.nickname, mon.name, mon.species, ""),
      onDone: (name: any) => finish(name),
      onCancel: () => finish(undefined),
    });
    if (!ok) {
      if (onDone) onDone(undefined);
      return false;
    }
    return true;
  }

  // Lua: World.lua:3213 -- the #DEX-completion diploma (engine/events/
  // diploma.asm). `special Diploma` never writes wScriptVar, so `onDone` takes
  // no argument.
  showDiploma(onDone?: OnDone_W2): boolean {
    const game = this.game;
    if (!(game && game.stack)) {
      if (onDone) onDone();
      return false;
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      game.stack.pop();
      if (onDone) onDone();
    };
    const ok = this.pushScreen("Gen2Diploma", {
      playerName: game.save && game.save.player ? game.save.player.name : undefined,
      onClose: finish,
    });
    if (!ok) {
      if (onDone) onDone();
      return false;
    }
    return true;
  }

  // Lua: World.lua:3244 -- the Magnet Train ride (engine/events/
  // magnet_train.asm). It READS the officer's wScriptVar, never writes one; the
  // `warpcheck` and `newloadmap MAPSETUP.TRAIN` after it are the script's.
  magnetTrain(toGoldenrod?: any, onDone?: OnDone_W2): boolean {
    const game = this.game;
    if (!(game && game.stack)) {
      if (onDone) onDone();
      return false;
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      game.stack.pop();
      if (onDone) onDone();
    };
    const ok = this.pushScreen("Gen2MagnetTrainRide", {
      toGoldenrod: toGoldenrod,
      onDone: finish,
    });
    if (!ok) {
      if (onDone) onDone();
      return false;
    }
    return true;
  }

  // Lua: World.lua:3273 -- the Cianwood photo studio's portrait card
  // (engine/printer/print_party.asm PrintPartyMonPage1).
  showPhotoStudio(mon?: any, onDone?: OnDone_W2): boolean {
    const game = this.game;
    if (!(game && game.stack)) {
      if (onDone) onDone();
      return false;
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      game.stack.pop();
      if (onDone) onDone();
    };
    const ok = this.pushScreen("Gen2PhotoStudio", {
      mon: mon,
      playerName: game.save && game.save.player ? game.save.player.name : undefined,
      onClose: finish,
    });
    if (!ok) {
      if (onDone) onDone();
      return false;
    }
    return true;
  }

  // Lua: World.lua:3303 -- the ALPH RUINS STAMP viewer (engine/events/
  // print_unown.asm _UnownPrinter).
  showUnownPrinter(onDone?: OnDone_W2): boolean {
    const game = this.game;
    if (!(game && game.stack)) {
      if (onDone) onDone();
      return false;
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      game.stack.pop();
      if (onDone) onDone();
    };
    const ok = this.pushScreen("Gen2UnownPrinter", { onClose: finish });
    if (!ok) {
      if (onDone) onDone();
      return false;
    }
    return true;
  }

  // Lua: World.lua:3331 -- PostCreditsSpawn (engine/menus/intro_menu.asm):
  // read wSpawnAfterChampion, clear it, and answer the spawn CONTINUE warps to
  // (SPAWN_NEW_BARK after the Elite Four, SPAWN_MT_SILVER after Red), or nil.
  consumePostGameSpawn(): any {
    const save = this.game ? this.game.save : undefined;
    const spawnId = HallOfFame.consumePostGameSpawn(save);
    if (!truthy(spawnId)) return undefined;
    const spawn = this.landmarks && this.landmarks.spawns
      ? this.landmarks.spawns[spawnId!] : undefined;
    if (!(spawn && truthy(spawn.map) && this.maps && this.maps[spawn.map])) {
      return undefined;
    }
    return spawn;
  }

  // Lua: World.lua:3366 -- `halloffame` ($9f) -> Script_halloffame -> HallOfFame
  // (engine/events/halloffame.asm), TWO screens: the roster ceremony, then
  // `pop af / jp Credits` with the PRE-induction wStatusFlags, whose
  // STATUSFLAGS_HALL_OF_FAME_F decides ALLOW_SKIPPING_CREDITS_F (a first-time
  // champion sits through the roll). HallOfFame.induct returns that pre-value
  // second. The save happens inside the ceremony (farcall SaveGameData), so it
  // goes through the same writer SaveMenu uses.
  hallOfFame(onDone?: OnDone_W2): boolean {
    const game = this.game;
    const save = game ? game.save : undefined;
    if (!(game && game.stack && save)) {
      if (onDone) onDone();
      return false;
    }

    // SaveGameData saves the whole of sPlayerData, so the live world is folded
    // in first (wEventFlags, the scene ids, wPlayerState). Lua pcall()s both.
    const [, wasEntered] = HallOfFame.induct(save, save.party, {
      saveFn: (data: any) => {
        if (game.snapshotSave) {
          try { game.snapshotSave(); } catch (_e) { /* pcall */ }
        }
        try { Gen2Save.save(data); } catch (_e) { /* pcall */ }
      },
    }) ?? [];

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      game.stack.pop();
      if (onDone) onDone();
      // ReturnFromCredits is Script_endall plus MAPSTATUS_DONE, and
      // FinishContinueFunction answers anything but SPAWN_RED with `jp Reset`,
      // so the champion's credits end on the title screen; the next CONTINUE
      // spawns at New Bark Town through World:consumePostGameSpawn.
      if (game.returnToTitle) game.returnToTitle();
    };

    // `pop af / jp Credits`: the roll follows the ceremony on the same call.
    const toCredits = () => {
      game.stack.pop();
      const ok = this.pushScreen("Gen2Credits", {
        allowSkip: wasEntered,
        onDone: finish,
      });
      if (!ok) { finished = true; if (onDone) onDone(); }
    };

    const ok = this.pushScreen("Gen2HallOfFame", {
      save: save,
      mode: "induct",
      // text carries the three header strings the extractor seeds by name.
      text: this.text,
      onDone: toCredits,
    });
    if (!ok) {
      if (onDone) onDone();
      return false;
    }
    return true;
  }

  // Lua: World.lua:3434 -- `credits` ($a0) -> Script_credits, `farcall
  // RedCredits`: the post-Red roll, no ceremony, SPAWN_RED, and wStatusFlags
  // read LIVE, so this roll is always skippable.
  credits(onDone?: OnDone_W2): boolean {
    const game = this.game;
    const save = game ? game.save : undefined;
    if (!(game && game.stack)) {
      if (onDone) onDone();
      return false;
    }
    HallOfFame.markRedCredits(save);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      game.stack.pop();
      if (onDone) onDone();
      // FinishContinueFunction's .AfterRed: SPAWN_RED does not `jp Reset`;
      // SpawnAfterRed writes SPAWN_MT_SILVER and the loop re-enters the
      // overworld through MAPSETUP.WARP, in session.
      const spawn = this.consumePostGameSpawn();
      if (spawn) {
        this.runMapSetup(MAPSETUP.WARP, () => {
          return this.setMap(spawn.map, spawn.x, spawn.y, "down");
        });
      }
    };
    const ok = this.pushScreen("Gen2Credits", {
      allowSkip: HallOfFame.hasEntered(save),
      onDone: finish,
    });
    if (!ok) {
      if (onDone) onDone();
      return false;
    }
    return true;
  }

  // Lua: World.lua:3476 -- the two Game Corner machines (StartGameCornerGame);
  // the coin-case refusal is transcribed in Specials, so this is the push.
  gameCornerGame(kind?: any, onDone?: OnDone_W2): boolean {
    const game = this.game;
    if (!(game && game.stack)) {
      if (onDone) onDone();
      return false;
    }
    const id = (kind === "cardflip") ? "Gen2CardFlip" : "Gen2SlotMachine";
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      game.stack.pop();
      if (onDone) onDone();
    };
    const ok = this.pushScreen(id, { save: game.save, onClose: finish });
    if (!ok) {
      if (onDone) onDone();
      return false;
    }
    return true;
  }

  // Lua: World.lua:3507 -- the Ruins of Alph sliding-panel puzzle: FadeToMenu /
  // _UnownPuzzle / wSolvedUnownPuzzle -> wScriptVar / ExitAllMenus. `puzzleId`
  // is the UNOWNPUZZLE_* the chamber's `setval` parked. A push that cannot
  // happen answers "not solved".
  unownPuzzle(puzzleId?: any, onDone?: OnDone_W2): boolean {
    const game = this.game;
    if (!(game && game.stack)) {
      if (onDone) onDone(false);
      return false;
    }
    let finished = false;
    const finish = (solved?: any) => {
      if (finished) return;
      finished = true;
      game.stack.pop();
      if (onDone) onDone(truthy(solved));
    };
    const ok = this.pushScreen("Gen2UnownPuzzle", {
      puzzle: puzzleId ?? 0,
      save: game.save,
      onClose: finish,
    });
    if (!ok) {
      if (onDone) onDone(false);
      return false;
    }
    return true;
  }

  // Lua: World.lua:3542 -- SurfStartStep (engine/overworld/player_object.asm),
  // the `special` half of the three lines World:runSurf runs: the state change,
  // the map's surfing theme, and one scripted step off the bank. Script_UsedSurf
  // calls it, so both routes land in the same place.
  surfStartStep(mon?: any): boolean {
    const p = this.player;
    if (!p) return false;
    this.applyPlayerState(FieldMoves.surfType(mon));
    const audio = this.game && this.game.data ? this.game.data.audio : undefined;
    if (audio && audio.runtime && this.map) {
      // SpecialMapMusic (home/audio.asm:397)
      Music.playMap(this.game.data, this.map.id, undefined,
                    FieldMoves.isSurfing(this.playerState), undefined,
                    this.mapMusicSong(this.map.id));
    }
    if (p.scriptStep) p.scriptStep(p.facing);
    this.fieldMove = { phase: "step" };
    return true;
  }

  // ---------------------------------------------------------------------------
  // W3: World.lua:3563-5212
  // ---------------------------------------------------------------------------

  // Lua: World.lua:3558-3575 -- the eight ROM-0 presentation specials
  // (FadeOutToWhite .. UpdatePlayerSprite). None of them is state: they are
  // the fade, the palette reload and the sprite refresh a scripted cutscene
  // brackets itself with. The fades are a flat overlay the renderer honours
  // (self.fade / fadeLevel / fadeHold / fadeWhiten, read through viewState).
  screenFade(kind: string): void {
    // kind: "outWhite" | "outBlack" | "inWhite" | "inBlack"
    if (kind === "inWhite" || kind === "inBlack") {
      this.fade = undefined;
      this.fadeLevel = undefined;
      this.fadeHold = undefined;
      this.fadeWhiten = undefined;
      return;
    }
    this.fade = (kind === "outWhite" ? "white" : "black") as FadeColor;
    this.fadeLevel = 1;
    this.fadeHold = undefined;
    // engine/tilesets/timeofday_pals.asm:122-128
    this.fadeWhiten = kind === "outWhite" ? true : undefined;
  }

  // Lua: World.lua:3577-3632 -- RunMapSetupScript
  // (engine/overworld/map_setup.asm): every map entry runs one of the eleven
  // MapSetupScripts, and the load itself sits in the MIDDLE of it. The port
  // loads a map in a single World:setMap call, so what is left of the script
  // is the pair of fades it is wrapped in -- and running the load between them
  // rather than instead of them is the whole difference between a door that
  // opens and a cut.
  //
  // The chain OWNS the frames it runs for: World:busy() is true throughout,
  // which is what stops a still-held direction from stepping the player on the
  // far side before the map's own deferred scene script gets to run.
  runMapSetup(method: number, load: () => any, fly?: any): any {
    // engine/events/overworld.asm:607
    if (!truthy(fly)) this.flyHidden = undefined;
    // JumpRoamMons sits above the load in MapSetupScript_Teleport;
    // UpdateRoamMons below it in _Connection and _Train. Wrapping the load
    // rather than editing setMap keeps both on the right side of it, and keeps
    // the roam walk where the cart puts it -- in the setup SCRIPT.
    this.roamMonsBeforeLoad(method);
    const wrapped = (): any => {
      // data/maps/setup_scripts.asm
      const prevMethod = this.setupMethod;
      this.setupMethod = method;
      const ok = load();
      this.setupMethod = prevMethod;
      // engine/overworld/map_objects_2.asm:1
      this.playerMasked = undefined;
      // data/maps/setup_scripts.asm:100; engine/overworld/map_setup.asm:88
      // engine/overworld/map_objects.asm:2481
      if (method === MAPSETUP.FALL) this.playerMasked = true;
      this.roamMonsAfterLoad(method);
      return ok;
    };
    if (MAPSETUP_NO_FADE[method]) return wrapped();
    if (!MAPSETUP_FADE_OUT[method]) {
      // MAPSETUP.WARP and friends open on DisableLCD: the screen simply goes,
      // and only the way back in is a fade.
      const ok = wrapped();
      this.fade = "white" as FadeColor;
      this.fadeLevel = 1;
      this.fadeWhiten = undefined;
      this.fadeHold = WARP_LOAD_WHITE_FRAMES;
      this.mapSetup = {
        phase: "in", step: FADE_STEPS,
        wait: WARP_LOAD_WHITE_FRAMES + FADE_STEP_FRAMES,
      } as MapSetupState;
      return ok;
    }
    // engine/tilesets/timeofday_pals.asm:122-128
    this.fadeWhiten = true;
    this.fadeHold = undefined;
    this.mapSetup = {
      phase: "out", step: 0, wait: FADE_STEP_FRAMES, load: wrapped,
      white: MAPSETUP_WARP_WINDOW[method] ? WARP_LOAD_WHITE_FRAMES
        : MAP_LOAD_WHITE_FRAMES,
    } as MapSetupState;
    return true;
  }

  // Lua: World.lua:3634-3643 -- the ramp with no load between the halves
  // (home/map.asm:2281-2292).
  exitMenusFade(whiteFrames?: number): void {
    this.fade = "white" as FadeColor;
    this.fadeLevel = 1;
    this.fadeWhiten = undefined;
    this.fadeHold = whiteFrames ?? MENU_EXIT_WHITE_FRAMES;
    this.mapSetup = {
      phase: "in", step: FADE_STEPS,
      wait: whiteFrames ?? MENU_EXIT_WHITE_FRAMES,
    } as MapSetupState;
  }

  // Lua: World.lua:3645-3650 -- engine/pokegear/pokegear.asm:2078,
  // home/menu.asm:83, home/map.asm:1928
  exitMenusFadeForFly(): void {
    this.exitMenusFade(FLY_EXIT_WHITE_FRAMES);
    // engine/events/overworld.asm:569-572, :611
    this.flyHidden = "from";
  }

  // Lua: World.lua:3652-3655 -- engine/menus/start_menu.asm:511,
  // engine/gfx/mon_icons.asm:287-297
  static flyCancelBlankFrames(partySize?: number): number {
    return FLY_CANCEL_BLANK_FRAMES + FLY_CANCEL_ICON_FRAMES * (partySize ?? 0);
  }

  // Lua: World.lua:3667-3673 -- the FADE_RAMP row (0-based, four shades) for a
  // fade colour and level, or undefined with no fade.
  static fadeRampRow(fade: FadeColor | undefined, level?: number): number[] | undefined {
    const ramp: number[][] | undefined = truthy(fade) ? World.FADE_RAMP[fade!] : undefined;
    if (!ramp) return undefined;
    const step = Math.max(1, Math.min(FADE_STEPS,
      Math.ceil((level ?? 1) * FADE_STEPS)));
    return ramp[step - 1];
  }

  // Lua: World.lua:3675-3678 -- home/fade.asm:22
  static fadeRampByte(row: number[]): number {
    return row[0]! * 64 + row[1]! * 16 + row[2]! * 4 + row[3]!;
  }

  // Lua: World.lua:3680-3688 -- data/maps/setup_scripts.asm:124-139
  battleReturnFade(): void {
    if (this.mapSetup) return;
    this.fade = "white" as FadeColor;
    this.fadeLevel = 1;
    this.fadeWhiten = undefined;
    this.fadeHold = WARP_LOAD_WHITE_FRAMES;
    this.mapSetup = {
      phase: "in", step: FADE_STEPS,
      wait: WARP_LOAD_WHITE_FRAMES + FADE_STEP_FRAMES,
    } as MapSetupState;
  }

  // Lua: World.lua:3690-3704 -- engine/tilesets/timeofday_pals.asm:160-187:
  // while fadeWhiten is set, BG palettes 2..7 take palette 1's first colour
  // in their first slot.
  fadeBgSet(): any {
    const def = this.map ? this.map.def : undefined;
    const bg = truthy(def) ? Palettes.bgSet(this.palettes, def, this.daytime) : undefined;
    if (!(truthy(bg) && truthy(this.fadeWhiten))) return bg;
    const out: any[] = [];
    for (let i = 0; i < bg.length; i++) {
      const colors = bg[i];
      if (colors == null) break; // ipairs stops at the first nil
      // Lua i in 2..7 (1-based) is JS 1..6
      if (i >= 1 && i <= 6 && bg[0] != null && bg[0][0] != null) {
        out[i] = [bg[0][0], colors[1], colors[2], colors[3]];
      } else {
        out[i] = colors;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Lua: World.lua:3706-3719 -- the three roaming beasts
  // (engine/overworld/wildmons.asm). src/core/gen2/Roamers.lua is the whole
  // model and the ONE writer of save.roamers -- the walk, the encounter roll,
  // the HP bank and the flee tables. Everything here is a call site: the four
  // the cart has -- two map setup commands, one gate at the top of
  // ChooseWildEncounter, and BattleEnd_HandleRoamMons.
  // ---------------------------------------------------------------------------

  // Lua: World.lua:3721-3725 -- Random(n) for the roam walk. Injectable so a
  // test and a driver can pin it; nil means the ambient stream.
  roamRandom(): any {
    return this.roamerRandom;
  }

  // Lua: World.lua:3727-3734
  roamMonsBeforeLoad(method: number): any {
    if (!MAPSETUP_ROAM_JUMP[method]) return false;
    const save = this.game ? this.game.save : undefined;
    if (!(truthy(save) && truthy(Roamers.list(save)))) return false;
    // The map the player is LEAVING: JumpRoamMons runs above the load.
    return Roamers.jumpAll(save, this.map ? this.map.id : undefined, this.roamRandom(),
      this.encounters);
  }

  // Lua: World.lua:3736-3743 -- the CONTINUE menu's own `farcall
  // JumpRoamMons`, which is not a map setup script at all: it fires once per
  // load of a save file, from World:load, with no map yet built -- so the map
  // the scatter avoids has to be passed in.
  roamMonsOnContinue(playerMapId: any): any {
    const save = this.game ? this.game.save : undefined;
    if (!(truthy(save) && truthy(Roamers.list(save)))) return false;
    return Roamers.jumpAll(save, playerMapId, this.roamRandom(), this.encounters);
  }

  // Lua: World.lua:3745-3752
  roamMonsAfterLoad(method: number): any {
    if (!MAPSETUP_ROAM_UPDATE[method]) return false;
    const save = this.game ? this.game.save : undefined;
    if (!(truthy(save) && truthy(Roamers.list(save)))) return false;
    // The map the player has ARRIVED on: UpdateRoamMons is the script's tail.
    return Roamers.update(save, this.map ? this.map.id : undefined, this.roamRandom(),
      this.encounters);
  }

  // Lua: World.lua:3754-3768 -- BattleEnd_HandleRoamMons. A roaming battle
  // banks the beast's HP and moves it (or clears the slot if it was caught or
  // beaten); ANY other wild battle takes the `.not_roaming` tail, a 1-in-16
  // roll that moves them all -- which is why the beasts drift while you grind.
  roamMonsAfterBattle(roaming: any, outcome: any, enemyHp: any): any {
    const save = this.game ? this.game.save : undefined;
    if (!(truthy(save) && truthy(Roamers.list(save)))) return false;
    const mapId = this.map ? this.map.id : undefined;
    if (truthy(roaming)) {
      return Roamers.endBattle(save, roaming, outcome, enemyHp, mapId,
        this.roamRandom(), this.encounters);
    }
    return Roamers.afterWildBattle(save, mapId, this.roamRandom(),
      this.encounters);
  }

  // Lua: World.lua:3770-3817 -- one frame of the map setup chain's fade.
  updateMapSetup(): void {
    const ms: MapSetupState = this.mapSetup;
    if (this.fadeHold != null) {
      this.fadeHold = this.fadeHold - 1;
      if (this.fadeHold <= 0) this.fadeHold = undefined;
    }
    ms.wait = ms.wait - 1;
    if (ms.wait > 0) return;
    ms.wait = FADE_STEP_FRAMES;
    if (ms.phase === "out") {
      ms.step = ms.step + 1;
      // engine/tilesets/timeofday_pals.asm:122-128
      if (ms.step <= FADE_STEPS) {
        this.fade = "white" as FadeColor;
        this.fadeLevel = ms.step / FADE_STEPS;
        return;
      }
      ms.load!();
      ms.phase = "in";
      ms.step = FADE_STEPS;
      this.fade = "white" as FadeColor;
      this.fadeLevel = 1;
      this.fadeWhiten = undefined;
      const white = ms.white ?? MAP_LOAD_WHITE_FRAMES;
      // home/lcd.asm:35-72
      this.fadeHold = white;
      // engine/tilesets/timeofday_pals.asm:277-299
      ms.wait = white + FADE_STEP_FRAMES;
      return;
    }
    ms.step = ms.step - 1;
    if (ms.step <= 0) {
      this.fade = undefined;
      this.fadeLevel = undefined;
      this.fadeHold = undefined;
      this.fadeWhiten = undefined;
      this.mapSetup = undefined;
      // `callasm FlyToAnim` is the command straight after `newloadmap
      // MAPSETUP_TELEPORT` (engine/events/overworld.asm:604-605).
      if (truthy(ms.flyIn)) {
        // engine/events/overworld.asm:607
        const respawn = (): void => { this.flyHidden = undefined; };
        if (!truthy(this.startFlyAnim("to", ms.flyIn, respawn))) respawn();
      }
      // engine/events/overworld.asm:869-870
      if (truthy(ms.digIn)) this.digReturn();
      // engine/overworld/events.asm:1008-1021
      if (truthy(ms.fallIn)) this.startSkyfall();
      return;
    }
    this.fadeLevel = ms.step / FADE_STEPS;
  }

  // Lua: World.lua:3819-3822
  reloadSprites(withPalettes?: boolean): void {
    this.rebuildPeople({ seamless: true });
    if (withPalettes !== false) this.applyPalettes();
  }

  // Lua: World.lua:3824-3964 -- every hook Specials.lua may reach for, in one
  // place so the module's whole surface is readable at a glance and a test can
  // stub it wholesale. `playerCell` returns the Lua's two values as [x, y].
  specialHooks(): Record<string, any> {
    return {
      world: this,
      healParty: () => { this.healParty(); },
      warpToSpawn: () => { this.warpToSpawn(); },
      openPc: () => { this.openPc(); },
      // _PlayersHousePC: the same screen with the DECORATION row, and an answer.
      playersHousePc: (onDone: any) => {
        this.openPc({ house: true, onDone });
      },
      toggleDecorationsVisibility: () => {
        this.toggleDecorationsVisibility();
      },
      toggleMaptileDecorations: () => { this.toggleMaptileDecorations(); },
      nameRival: (onDone: any) => { this.nameRival(onDone); },
      playSfx: (id: any) => { this.playSfx(id); },
      // The same sound by its pokegold LABEL, for a handler porting a `ld de,
      // SFX_x / call PlaySFX` pair: the Gold sfx table is keyed by label, and
      // an index written down in Lua is only right until the table moves.
      playSfxNamed: (name: any, fallbackId: any) => {
        this.playSfxNamed(name, fallbackId);
      },
      playCry: (index: any) => { this.playCry(index); },
      playMapMusic: () => { this.playMapMusic(); },
      restartMapMusic: () => { this.restoreMapMusic(); },
      fadeOutMusic: () => { Music.fadeOut(2); },
      stopMusic: () => { Music.stop(); },
      currentMusic: () => Music.current(),
      fade: (kind: string) => { this.screenFade(kind); },
      reloadSprites: (withPalettes?: boolean) => { this.reloadSprites(withPalettes); },
      updatePlayerSprite: () => { this.applyPlayerState(this.playerState); },
      surfStartStep: (mon: any) => this.surfStartStep(mon),
      save: () => (this.game ? this.game.save : undefined),
      data: () => (this.game ? this.game.data : undefined),
      party: () => {
        const save = this.game ? this.game.save : undefined;
        return (save && truthy(save.party)) ? save.party : [];
      },
      // Lua's two results, as [x, y].
      playerCell: (): [number, number] => {
        const p = this.player;
        return [p && p.cellX != null ? p.cellX : 0, p && p.cellY != null ? p.cellY : 0];
      },
      mapId: () => (this.map ? this.map.id : undefined),
      coins: () => this.coins(),
      setCoins: (value: any) => { this.setCoins(value); },
      money: (account: any) => this.money(account),
      setMoney: (account: any, value: any) => { this.setMoney(account, value); },
      // Mom_SetUpWithdrawMenu / Mom_SetUpDepositMenu's six-digit money keypad
      // (src/script/gen2/Specials.lua H.BankOfMom). `onDone` gets the typed
      // amount or nil for B; the special itself owns the balance checks.
      bankOfMomAmount: (kind: any, saved: any, held: any, onDone: any) =>
        this.bankOfMomAmount(kind, saved, held, onDone),
      hasItem: (index: any) => this.hasItem(index),
      takeItem: (index: any, qty: any) => this.takeItem(index, qty),
      engineFlag: (flag: any) => this.engineFlag(flag),
      setEngineFlag: (flag: any, v: any) => { this.setEngineFlag(flag, v); },
      setSwarm: (group: any, mapNum: any, kind: any) => { this.setSwarm(group, mapNum, kind); },
      dayCare: (side: any, onDone: any) => { this.dayCare(side, onDone); },
      givePokeMail: (mail: any) => this.givePokeMail(mail),
      checkPokeMail: (mail: any, onDone: any) => { this.checkPokeMail(mail, onDone); },
      gameCornerGame: (kind: any, onDone: any) => {
        this.gameCornerGame(kind, onDone);
      },
      unownPuzzle: (puzzleId: any, onDone: any) => {
        this.unownPuzzle(puzzleId, onDone);
      },
      selectPartyMon: (prompt: any, onDone: any) => {
        this.selectPartyMon(prompt, onDone);
      },
      chooseMoveToDelete: (mon: any, onDone: any) => {
        this.chooseMoveToDelete(mon, onDone);
      },
      renameMon: (mon: any, onDone: any, opts: any) => {
        this.renameMon(mon, onDone, opts);
      },
      setDayOfWeek: (onDone: any) => { this.setDayOfWeek(onDone); },
      showDiploma: (onDone: any) => {
        this.showDiploma(onDone);
      },
      showPhotoStudio: (mon: any, onDone: any) => {
        this.showPhotoStudio(mon, onDone);
      },
      showUnownPrinter: (onDone: any) => {
        this.showUnownPrinter(onDone);
      },
      magnetTrain: (toGoldenrod: any, onDone: any) => {
        this.magnetTrain(toGoldenrod, onDone);
      },
      // ../pokecrystal/engine/events/battle_tower/battle_tower.asm:220-223
      startTowerBattle: (trainer: any, onDone: any) =>
        this.startBattle({ trainer, battleTower: true }, onDone),
      // ../pokecrystal/engine/events/battle_tower/battle_tower.asm:1552-1575
      setObjectSprite: (objectId: any, spriteName: any) =>
        this.setObjectSprite(objectId, spriteName),
      pushScreen: (id: any, opts: any) => this.pushScreen(id, opts),
      monName: (index: any) => {
        const [id, def] = speciesByIndex(
          this.game && this.game.data ? this.game.data.pokemon : undefined, index);
        return (def && truthy(def.name)) ? def.name : id;
      },
      monIndex: (species: any) => {
        const pokemon = this.game && this.game.data ? this.game.data.pokemon : undefined;
        const def = pokemon ? pokemon[species] : undefined;
        return (def && truthy(def.index)) ? def.index : undefined;
      },
      // The item pair, the way monName / monIndex are the species pair: a
      // handler that builds a menu needs the printed name, and one that leaves
      // an item in wScriptVar needs the CONSTANT the following `ifequal` ladder
      // compares against (Kurt's is `ifequal BLU_APRICORN`).
      itemName: (id: any) => {
        const items = this.game && this.game.data ? this.game.data.items : undefined;
        const def = items ? items[id] : undefined;
        return (def && truthy(def.name)) ? def.name : id;
      },
      itemIndex: (id: any) => {
        const items = this.game && this.game.data ? this.game.data.items : undefined;
        const def = items ? items[id] : undefined;
        return (def && truthy(def.index)) ? def.index : undefined;
      },
      // The same static menu `loadmenu` / `verticalmenu` opens, for the
      // handlers whose menu is compiled into a routine instead of into a
      // MenuHeader the extractor can follow (Kurt_SelectApricorn builds its
      // rows at run time out of the pack).
      scriptMenu: (header: any, onChoose: any) => {
        this.openScriptMenu(header, "vertical", onChoose);
      },
      rareWildMon: () => this.rareWildMon(),
      // ../pokecrystal/engine/menus/save.asm:181 AskOverwriteSaveFile and :266
      // _SaveGameData, the two halves of Link_SaveGame (:63). saveFileState
      // returns [exists, sameId].
      saveFileState: () => this.saveFileState(),
      writeSave: () => this.writeSave(),
      setKurtApricornQuantity: (n: any) => { this.setKurtApricornQuantity(n); },
      setKenjiBreak: (days: any) => { this.setKenjiBreak(days); },
    };
  }

  // Lua: World.lua:3966-3977 -- AskOverwriteSaveFile's two reads:
  // wSaveFileExists, and CompareLoadedAndSavedPlayerID
  // (../pokecrystal/engine/menus/save.asm:224), which is what picks
  // AlreadyASaveFileText over AnotherSaveFileText. Returns the Lua's two
  // values as [exists, sameId].
  saveFileState(): [boolean, boolean] {
    const save = this.game ? this.game.save : undefined;
    const version = save ? save.version : undefined;
    if (!truthy(Gen2Save.exists(version))) return [false, false];
    // Save.load returns the Lua's several results as a tuple; the table is [0].
    const [stored] = Gen2Save.load(version);
    const mine = save && save.player ? save.player.id : undefined;
    const theirs = stored && stored.player ? stored.player.id : undefined;
    return [true, mine != null && mine === theirs];
  }

  // Lua: World.lua:3979-3985 -- _SaveGameData, through the writer the SAVE
  // menu is handed (src/core/Game2.lua:435) so the save.write veto holds here.
  writeSave(): boolean {
    const game = this.game;
    if (!(game && truthy(game.writeSave))) return false;
    return game.writeSave() !== false;
  }

  // Lua: World.lua:3987-4008 -- RandomUnseenWildMon's lookup half. The routine
  // picks one of the THREE RAREST grass slots on the map (`and %11 / jr z`
  // rerolls 0, so it is slots 5, 6 or 7 of the seven) and drops it if that
  // species is also one of the FOUR COMMONEST -- which is what stops the caller
  // reporting a Rattata as a rarity. The time of day picks the list.
  rareWildMon(): any {
    const map = this.map;
    const entry = this.encounters && this.encounters.grass && map
      ? this.encounters.grass[map.id] : undefined;
    if (!entry || !entry.slots) return undefined;
    const key = this.tod ?? "DAY";
    const slots = entry.slots[key] ?? entry.slots.DAY;
    if (!slots) return undefined;
    // Lua slots[4 + math.random(3)]: 1-based 5..7 is JS 4..6
    const rare = slots[3 + random(3)];
    if (!(rare && truthy(rare.species))) return undefined;
    for (let i = 0; i < 4; i++) {
      const common = slots[i];
      if (common && common.species === rare.species) return undefined;
    }
    return rare.species;
  }

  // Lua: World.lua:4010-4019
  objectEntity(objectId: any): any {
    if (objectId === 0) return this.player;
    // object_const_def starts at 2; extracted objects are 1-based.
    const index = (objectId ?? 0) - 1;
    if (index < 1) return this.talkNpc;
    for (const npc of this.npcs) {
      if (npc.def && npc.def.index === index) return npc;
    }
    return undefined;
  }

  // Lua: World.lua:4021-4024
  turnObject(objectId: any, facing: any): void {
    const ent = this.objectEntity(objectId);
    if (ent && ent.scriptFace) ent.scriptFace(facing);
  }

  // Lua: World.lua:4026-4057
  disappearObject(objectId: any): void {
    // home/map_objects.asm:317
    if (objectId === 0) {
      this.playerMasked = true;
      return;
    }
    const index = (objectId ?? 0) - 1;
    const def = this.map ? this.map.def : undefined;
    // def.objects is 0-based; object `index` is 1-based (its .index field).
    const obj = def && def.objects ? def.objects[index - 1] : undefined;
    if (!obj) return;
    // Script_disappear does TWO separate stores, and only one of them is the
    // flag. DeleteObjectStruct -> MaskObject (home/map_objects.asm:347,
    // home/map.asm:1542) writes the byte of wObjectMasks for THIS object and
    // nothing else, which is what takes it off the map now; the flag
    // ApplyEventActionAppearDisappear sets afterwards is only what the next
    // LoadObjectMasks reads back at map load. Objects sharing one
    // MAPOBJECT_EVENT_FLAG are ordinary (maps/BurnedTowerB1F.asm:152), so the
    // mask is per object even when the flag is not.
    //
    // ApplyEventActionAppearDisappear returns WITHOUT touching anything when
    // the flag word is -1 ($ffff), and MaskObject has already pulled the struct
    // by then -- so an object with no real flag still vanishes for the rest of
    // the map's visit. Events:objectVisible reads $ffff as "always visible", so
    // the mask is what hides the flagless ones, and the next load re-derives
    // every mask from the flags.
    if (truthy(obj.eventFlag) && obj.eventFlag !== 0xFFFF) {
      this.events.set(obj.eventFlag, true);
    }
    this.setObjectMask(obj, index, true);
    this.rebuildPeople({ seamless: true });
  }

  // Lua: World.lua:4059-4071 -- StartFollow: the follower's movement type
  // becomes SPRITEMOVEDATA_FOLLOWING and it walks the leader's own path one
  // cell behind. Only one pair exists at a time (wObjectFollow_Leader /
  // _Follower are single bytes), so a second `follow` replaces the first.
  startFollow(leaderId: any, followerId: any): void {
    const leader = this.objectEntity(leaderId);
    const follower = this.objectEntity(followerId);
    if (!(leader && follower) || leader === follower) {
      this.followState = undefined;
      return;
    }
    this.followState = { leader, follower };
  }

  // Lua: World.lua:4073-4075
  stopFollow(): void {
    this.followState = undefined;
  }

  // Lua: World.lua:4077-4093 -- the leader has just committed to a step out of
  // (fromX, fromY); the follower takes that cell if it is standing next to it.
  // A follower that is somewhere else entirely simply does not move, the way
  // CheckObjectVisibility drops a pairing it cannot make sense of.
  followStep(leader: any, fromX: number, fromY: number): void {
    const state = this.followState;
    if (!(state && state.leader === leader)) return;
    const follower = state.follower;
    if (!follower || truthy(follower.moving) || !follower.scriptStep) return;
    const dx = fromX - follower.cellX;
    const dy = fromY - follower.cellY;
    let dir: Dir | undefined;
    if (dy === 0 && dx === 1) dir = "right";
    else if (dy === 0 && dx === -1) dir = "left";
    else if (dx === 0 && dy === 1) dir = "down";
    else if (dx === 0 && dy === -1) dir = "up";
    if (dir) follower.scriptStep(dir);
  }

  // Lua: World.lua:4095-4113 -- FreezeAllObjects + the caller's `res
  // FROZEN_F` on the moved one (engine/overworld/map_objects.asm
  // FreezeAllOtherObjects, :2529-2544), plus UnfreezeFollowerObject
  // (scripting.asm:758): a follower is walked by World:followStep and must not
  // be held. The pool is walked as well as self.npcs because a rebuild
  // mid-script can leave an object in one list and not the other.
  freezeAllOtherNpcs(objectId: any): void {
    const moved = this.objectEntity(objectId);
    const follower = this.followState ? this.followState.follower : undefined;
    const hold = (npc: any): void => {
      if (npc && npc !== moved && npc !== follower && npc !== this.player) {
        npc.frozen = true;
      }
    };
    for (const npc of Object.values(this.npcPool ?? {})) hold(npc);
    for (const npc of this.npcs ?? []) hold(npc);
  }

  // Lua: World.lua:4115-4143
  beginMovement(objectId: any, bytes?: number[], onDone?: () => void): void {
    // ApplyMovement's FIRST act, before it has even read the movement pointer:
    // `ld a, c / farcall FreezeAllOtherObjects` (engine/overworld/scripting.asm
    // :751-755). FreezeAllObjects sets FROZEN_F on every struct and the caller
    // then clears it on the one being moved (map_objects.asm:2529-2544), so
    // from the first applymovement of a script until EndScript's
    // UnfreezeAllObjects NOBODY on the map moves under their own movement
    // function. (A beaten spinner kept rolling facings through his own
    // after-battle text, and the Rocket hideout's spin trainers turned under
    // every text box, while only the touched object froze.)
    //
    // `frozeNpcs` is the release latch: World:step drops it the frame the whole
    // interaction settles, which is where the cart runs UnfreezeAllObjects.
    this.freezeAllOtherNpcs(objectId);
    this.frozeNpcs = true;
    this.moveState = {
      objectId,
      bytes: bytes ?? [],
      i: 1,
      sleep: 0,
      onDone,
    } as MoveState;
  }

  // Lua: World.lua:4145-4285 -- one frame of the applymovement stream.
  updateMovement(): void {
    const st: MoveState | undefined = this.moveState;
    if (!st) return;
    const ent = this.objectEntity(st.objectId);
    if (!ent) {
      const cb = st.onDone;
      this.moveState = undefined;
      if (cb) cb();
      return;
    }
    if (st.sleep && st.sleep > 0) {
      st.sleep = st.sleep - 1;
      return;
    }
    if (truthy(ent.moving)) return;
    // engine/overworld/map_objects.asm:1150
    if (st.pendingStep) {
      const dir = st.pendingStep;
      st.pendingStep = undefined;
      const fromX = ent.cellX;
      const fromY = ent.cellY;
      if (truthy(ent.scriptStep(dir))) this.followStep(ent, fromX, fromY);
      return;
    }
    while (st.i <= st.bytes.length) {
      const b = st.bytes[st.i - 1]!;
      st.i = st.i + 1;
      // Movement_step_dig spins for the frames in the byte that follows
      // -- engine/overworld/movement.asm:113-131 (#1716)
      if (b === Movement.STEP_DIG) {
        const duration = st.bytes[st.i - 1] ?? 0;
        st.i = st.i + 1;
        if (ent.scriptSpin) ent.scriptSpin(duration);
        st.sleep = duration;
        return;
      }
      // engine/overworld/movement.asm:142-160, map_objects.asm:1481-1493
      if (b === Movement.RETURN_DIG) {
        const duration = st.bytes[st.i - 1] ?? 0;
        st.i = st.i + 1;
        if (ent.scriptSpin) ent.scriptSpin(duration, true);
        st.sleep = duration;
        return;
      }
      // engine/overworld/movement.asm:163
      if (b === 0x57) {
        const duration = st.bytes[st.i - 1] ?? 0;
        st.i = st.i + 1;
        if (ent.scriptRockSmash) {
          ent.scriptRockSmash(duration);
        }
        st.sleep = duration;
        return;
      }
      const act: MovementAction = Movement.decodeByte(b);
      if (act.kind === "end") {
        // SLIDING_F is an object flag, not a stream one, so a stream that
        // never ran remove_sliding would otherwise leave the object stuck
        // holding its facing and step frame forever.
        ent.sliding = undefined;
        const cb = st.onDone;
        this.moveState = undefined;
        if (cb) cb();
        return;
      } else if (act.kind === "turn") {
        ent.scriptFace(act.dir);
      } else if (act.kind === "step") {
        const fromX = ent.cellX;
        const fromY = ent.cellY;
        if (truthy(ent.scriptStep(act.dir))) {
          // TurningStep's OBJECT_ACTION_SPIN, for the length of the step
          // (engine/overworld/movement.asm:693-699).
          if (act.spin && ent.scriptSpin) {
            ent.scriptSpin(ent.stepFrames ?? 16);
          }
          this.followStep(ent, fromX, fromY);
        }
        return;
      } else if (act.kind === "jump") {
        // JumpStep (engine/overworld/movement.asm:741) hands the object to
        // StepFunction_NPCJump, which runs TWO beats and advances
        // OBJECT_MAP_X/Y on each, so a jump crosses two cells. No collision
        // test: InitStep and GetNextTile only record the tile for the grass
        // flag and never block scripted movement.
        const fromX = ent.cellX;
        const fromY = ent.cellY;
        if (ent.scriptJump && truthy(ent.scriptJump(act.dir))) {
          this.followStep(ent, fromX, fromY);
        } else if (!ent.scriptJump && truthy(ent.scriptStep(act.dir))) {
          st.pendingStep = act.dir;
          this.followStep(ent, fromX, fromY);
        }
        return;
      } else if (act.kind === "sleep") {
        st.sleep = act.frames ?? 0;
        return;
      } else if (act.kind === "teleport") {
        // teleport_from / teleport_to hand the object to their own step type
        // for a fixed number of frames (NPC:scriptTeleport); the movement
        // stream waits them out on the same counter step_sleep uses.
        if (ent.scriptTeleport) {
          ent.scriptTeleport(act.mode, act.frames);
          st.sleep = act.frames ?? 0;
        }
        return;
      } else if (act.kind === "sliding") {
        // Movement_set_sliding / _remove_sliding (engine/overworld/movement.asm
        // :353-363) toggle SLIDING_F; SetFacingStepAction and
        // SetFacingBumpAction both bail to SetFacingCurrent while it is set
        // (engine/overworld/map_object_action.asm:48, :74), so the object holds
        // its facing AND its step frame for the whole stream. Both handlers end
        // in `jp ContinueReadingMovement`, so no frame is consumed and the next
        // byte is read in this same pass: fall through the while loop.
        ent.sliding = act.on;
      } else if (act.kind === "fixfacing") {
        // FIXED_FACING_F: InitStep jumps past the OBJECT_DIRECTION write
        // (engine/overworld/map_objects.asm:284-294), so the object steps
        // without turning. ContinueReadingMovement again, so no frame here.
        ent.fixedFacing = act.fixed;
      } else if (act.kind === "visible") {
        // macros/scripts/movement.asm:99-106
        if (st.objectId === 0) {
          this.playerHidden = !truthy(act.on) ? true : undefined;
        } else {
          ent.hiddenByMovement = !truthy(act.on) ? true : undefined;
        }
      } else if (act.kind === "treeshake") {
        // Movement_tree_shake: 24 frames of STEP_TYPE_SLEEP with OBJECT_ACTION
        // set to OBJECT_ACTION_WEIRD_TREE (engine/overworld/movement.asm:334).
        if (ent.scriptTreeShake) {
          ent.scriptTreeShake(act.frames);
          st.sleep = act.frames ?? 0;
        }
        return;
      }
    }
    // A stream that walked off the end of its bytes without an `end` byte
    // still has to drop SLIDING_F: the flag lives on the object, and leaving it
    // set freezes that NPC's facing and step frame for the rest of the map.
    ent.sliding = undefined;
    const cb = st.onDone;
    this.moveState = undefined;
    if (cb) cb();
  }

  // Lua: World.lua:4287-4332
  askYesNo(onChoose?: (yes: boolean) => void): void {
    const game = this.game;
    if (!(game && game.stack)) {
      if (onChoose) onChoose(true);
      return;
    }
    this.choicebox = true;
    // The box World:showText left standing because this very command was the
    // next one in the list. Handing it the shared TextBox's own `choice` hook
    // is what puts the prompt over it: the stay latch has to come off first,
    // since a staying box short-circuits before the choice branch
    // (src/render/TextBox.lua:238). Nothing is re-printed, so the page keeps
    // the exact two lines it typed -- including a `cont`'s scrolled pair.
    const held = this.stayedTextBox;
    if (held) {
      this.stayedTextBox = undefined;
      held.stay = undefined;
      held.choice = (yes: boolean) => {
        this.textbox = undefined;
        this.choicebox = undefined;
        if (onChoose) onChoose(yes);
      };
      return;
    }
    // `yesorno` on the cart puts the YES/NO box ABOVE the text box that is
    // still holding the question (InitYesNoTextBoxParameters). The last page
    // is re-shown instantly underneath and the shared TextBox's own `choice`
    // hook stacks the prompt on it, the same pairing every Gen 1 prompt uses.
    const question = this.lastText;
    if (truthy(question)) {
      game.stack.push(TextBox.new(game, question, undefined, {
        instant: true,
        choice: (yes: boolean) => {
          this.choicebox = undefined;
          if (onChoose) onChoose(yes);
        },
      }));
      return;
    }
    game.stack.push(ChoiceBox.new(game, (yes: boolean) => {
      this.choicebox = undefined;
      if (onChoose) onChoose(yes);
    }));
  }

  // Lua: World.lua:4341-4362 -- the `pokepic` window's state. The picture is
  // the cooked Gold-screen image for the species' front pic (Assets.image,
  // whose tile grid the pokepic draw puts in the POKEPIC box).
  showPokePic(speciesIndex: any): void {
    const [id, def] = speciesByIndex(
      this.game && this.game.data ? this.game.data.pokemon : undefined, speciesIndex);
    let path = def ? def.spriteFront : undefined;
    if (!truthy(path)) { this.pokePic = undefined; return; }
    // Sprites.pic returns the Lua's two values (path, trueColor) as a tuple.
    const [picPath, trueColor] = Sprites.pic(path, {
      species: id,
      side: "front",
      kind: "overworld",
      data: this.game ? this.game.data : undefined,
    });
    path = picPath;
    let img: any;
    try {
      img = Assets.image(path);
    } catch {
      img = undefined;
    }
    this.pokePic = truthy(img) ? img : undefined;
    this.pokePicTrueColor = trueColor;
    this.pokePicName = id;
    // _CGB_Pokepic (engine/gfx/cgb_layouts.asm:744) fills the whole menu box
    // with PAL_BG_GRAY, so the window is the map's grey ramp, not the mon's
    // colors.
    const set = this.palettes && this.map && this.map.def
      ? Palettes.bgSet(this.palettes, this.map.def, this.daytime ?? "DAY") : undefined;
    this.pokePicColors = truthy(set) && set[0] != null ? set[0] : undefined;
  }

  // Lua: World.lua:4364-4377 -- WaitButton (home/text.asm), which
  // Script_waitbutton farcalls: hold the frame until the player presses A or
  // B. Only the `waitbutton` under an open `pokepic` window reaches here, and
  // it is what puts the starter's pic on screen long enough to look at before
  // the yes/no (#911).
  //
  // `fresh` skips the tick the wait was armed on. Game2's fixed step reads
  // `wasPressed("a")` for World:interact ABOVE World:step, so the press that
  // opened the ball script is still this tick's edge when the poll first runs.
  waitForButton(done?: () => void): void {
    this.waitButton = { done, fresh: true };
  }

  // Lua: World.lua:4379-4391
  pollWaitButton(): void {
    const wb = this.waitButton;
    if (!wb) return;
    if (wb.fresh) { wb.fresh = false; return; }
    const input = this.game ? this.game.input : undefined;
    // A headless build with no pad cannot answer, so it answers at once rather
    // than parking the script forever.
    if (input && !(truthy(input.wasPressed("a")) || truthy(input.wasPressed("b")))) {
      return;
    }
    this.waitButton = undefined;
    if (wb.done) wb.done();
  }

  // Lua: World.lua:4393-4447 -- the wild pick, wrapped in encounter.roll
  // (return nil to suppress, a table without calling next_ to force) and then
  // encounter.species (which transforms a non-nil roll before the Unown and
  // repel filters). ctx keeps Gen 1's mapId / terrain / rng and adds what a
  // Gen 2 roll depends on: `daytime`, `environment` (a CAVE or DUNGEON
  // encounters on every walkable tile), `kind` ("wild", "contest" or
  // "script") and `tables`, the swarm-substituted lists the engine really
  // rolled from. WHETHER a step may roll at all is CanEncounterWildMon
  // (FieldMoves.canEncounterWildMon); WHICH list is rolled is CheckOnWater.
  rollEncounter(kind: string, terrain: string, tables: any, vanilla: (tables: any, ctx: any) => any): any {
    const map = this.map;
    const ctx = {
      mapId: map ? map.id : undefined,
      terrain,
      // love.math.random / math.random: the seeded stream (platform/rng.ts).
      rng: random,
      kind,
      daytime: this.tod,
      environment: map && map.def ? map.def.environment : undefined,
      tables,
      data: this.game ? this.game.data : undefined,
    };
    if (!(Runtime.wantsHook("encounter.roll")
          || Runtime.wantsHook("encounter.species"))) {
      return vanilla(tables, ctx);
    }
    let enc = Runtime.call("encounter.roll", vanilla, tables, ctx);
    if (truthy(enc)) {
      // sameEncounter takes one argument; the chain also hands it ctx.
      enc = Runtime.call("encounter.species", (e: any, _ctx: any) => sameEncounter(e), enc, ctx);
    }
    return enc;
  }

  // Lua: World.lua:4458-4464 -- ApplyMusicEffectOnEncounterRate.
  static musicEncounterRate(rate: number | undefined, song: string | undefined): number | undefined {
    const effect = rate != null && truthy(song) ? MUSIC_RATE[song!] : undefined;
    if (!effect) return rate;
    // `sla b` / `srl b`, so the double wraps at a byte like the cart's does.
    if (effect === "half") return Math.floor(rate! / 2);
    return mod(rate! * 2, 256);
  }

  // Lua: World.lua:4466-4556 -- a step's wild encounter. Returns true when a
  // battle started, so the caller stops the step.
  tryWildEncounter(): boolean {
    const game = this.game;
    const player = this.player;
    const map = this.map;
    if (!(game && player && map && this.encounters)) return false;
    if (this.wildCooldownStep()) return false;
    const save = game.save;
    if (!(save && save.party && save.party.length > 0)) return false;
    const collision = map.cellCollision(player.cellX, player.cellY);
    const environment = map.def ? map.def.environment : undefined;
    if (!truthy(FieldMoves.canEncounterWildMon(
      environment, collision, this.noWildEncounters))) {
      return false;
    }
    // RandomEncounter's `bit STATUSFLAGS2_BUG_CONTEST_TIMER_F` gate sits
    // between CanEncounterWildMon and TryWildEncounter, and it takes a WHOLE
    // different path: the park's own table, its own two encounter rates, and no
    // roamer check at all -- which is why no beast can turn up in the contest.
    if (truthy(BugContest.isActive(save))) {
      return this.tryContestEncounter(collision);
    }
    // TryWildEncounter's own order: `.EncounterRate` FIRST, and
    // ChooseWildEncounter -- roamer check included -- only on a pass.
    const tables = this.wildTables();
    const onWater = FieldMoves.encounterTable(collision) === "water";
    let rate: number | undefined;
    if (onWater) {
      rate = Encounter.waterRate(tables, map.id);
    } else {
      // engine/overworld/wildmons.asm:283
      rate = Encounter.grassRate(tables, map.id, this.tod);
    }
    // ApplyMusicEffectOnEncounterRate runs first (wildmons.asm:213-215).
    rate = World.musicEncounterRate(rate, Music.mapSong() ?? undefined);
    // ApplyCleanseTagEffectOnEncounterRate (engine/overworld/wildmons.asm:
    // 250-267): one `srl b`, however many mons are holding one.
    for (const mon of save.party ?? []) {
      if (rate != null && mon.item === "CLEANSE_TAG") {
        rate = Math.floor(rate / 2);
        break;
      }
    }
    if (!truthy(Encounter.triggers(rate, undefined))) return false;
    // CheckEncounterRoamMon is the FIRST thing ChooseWildEncounter does, before
    // it reaches for the map's own slot list -- so a beast REPLACES the map's
    // encounter rather than adding to it, and only on a map that has a table
    // at all. Roamers.checkEncounter refuses while surfing, which is what keeps
    // Suicune out of the water.
    const met: any = Roamers.checkEncounter(save, map.id, onWater, this.roamRandom());
    if (truthy(met)) {
      // CheckEncounterRoamMon writes wCurPartyLevel like any other pick, so the
      // repel filter below applies to a beast too.
      if (this.repelSuppresses(met.level)) return false;
      const beast = Roamers.beginBattle(save, met.index, game.data);
      if (truthy(beast)) {
        save.pokedex = save.pokedex ?? { seen: {}, caught: {} };
        save.pokedex.seen[beast.species] = true;
        this.startBattle({ wild: beast, roaming: met.index });
        return true;
      }
    }
    const roll = this.rollEncounter("wild", onWater ? "water" : "grass",
      tables, onWater ? rollWaterVanilla : rollGrassVanilla);
    if (!truthy(roll)) return false;
    // ChooseWildEncounter's Unown arm (engine/overworld/wildmons.asm): an UNOWN
    // slot on a map whose puzzles are all unsolved is NO ENCOUNTER --
    // `ld a, [wUnlockedUnowns] / and a / jr z, .nowildbattle`. That is what
    // keeps the Ruins chambers empty until a wall has been solved.
    let monOpts: any = undefined;
    if (roll.species === Unown.SPECIES) {
      const flags = this.unownUnlockFlags();
      if (!truthy(Unown.anyUnlocked(flags))) return false;
      // LoadEnemyMon's .GenerateDVs loop rerolls until CheckUnownLetter clears
      // the form, so a chamber only ever produces letters its own puzzle
      // unlocked.
      monOpts = { dvs: Unown.wildDVs(flags, Mon.randomDVs as any) };
    }
    // CheckRepelEffect, the last gate TryWildEncounter runs, and it runs AFTER
    // the mon has been chosen -- so a repel filters on the level rolled.
    if (this.repelSuppresses(roll.level)) return false;
    const wild = Mon.new(game.data, roll.species, roll.level, monOpts);
    if (!truthy(wild)) return false;

    save.pokedex = save.pokedex ?? { seen: {}, caught: {} };
    save.pokedex.seen[roll.species] = true;
    this.startBattle({ wild });
    return true;
  }

  // Lua: World.lua:4558-4582 -- CheckRepelEffect
  // (engine/overworld/wildmons.asm). With wRepelEffect (save.repelSteps) still
  // ticking, the chosen encounter is dropped when its level is BELOW the first
  // party member that is not fainted (`cp [hl] / jr nc, .encounter` takes it
  // on greater-or-equal). The walk skips every slot whose HP is zero, so an EGG
  // is never the mon a repel measures against. The counter is
  // StepEvents.repelStep's; nothing here touches it.
  repelSuppresses(level: any): boolean {
    const save = this.game ? this.game.save : undefined;
    if (!save) return false;
    if ((save.repelSteps ?? 0) <= 0) return false;
    if (level == null) return false;
    let lead: any;
    for (const mon of save.party ?? []) {
      if ((mon.hp ?? 0) > 0) {
        lead = mon;
        break;
      }
    }
    if (!(lead && lead.level != null)) return false;
    return level < lead.level;
  }

  // Lua: World.lua:4584-4593 -- CheckWildEncounterCooldown
  // (engine/overworld/events.asm:357-365), the first thing RandomEncounter
  // runs (events.asm:1122): zero is a free step, otherwise the counter ticks
  // and only the step that lands on zero may roll.
  wildCooldownStep(): boolean {
    let left = this.wildCooldown ?? 0;
    if (left <= 0) return false;
    left = left - 1;
    this.wildCooldown = left;
    return left > 0;
  }

  // Lua: World.lua:4595-4604 -- LoadWildMonDataPointer's first move:
  // _SwarmWildmonCheck searches SwarmGrassWildMons / SwarmWaterWildMons ahead
  // of the Johto and Kanto tables, only while the player is standing on the
  // swarm's own map. Roamers.Swarm.tables hands the ORIGINAL table back when no
  // swarm applies.
  wildTables(): any {
    const save = this.game ? this.game.save : undefined;
    if (!(save && this.map && this.encounters)) return this.encounters;
    return Roamers.Swarm.tables(save, this.encounters, this.map.id);
  }

  // ---------------------------------------------------------------------------
  // Lua: World.lua:4606-4622 -- the Bug Catching Contest
  // (engine/events/bug_contest/). src/core/gen2/BugContest.lua is the whole
  // model; what lives here is the four CALL SITES the cart has:
  //   RandomEncounter's contest branch          World:tryContestEncounter
  //   CheckTimeEvents' CheckBugContestTimer     World:checkTimeEvents
  //   BugCatchingContestBattleScript's tail     World:bugContestBattleOver
  //   BugCatchingContestOverScript              World:bugContestOver
  // ---------------------------------------------------------------------------

  // Lua: World.lua:4624-4645 -- _TryWildEncounter_BugContest: the rate is the
  // tile's (40 percent in the park's long grass, 20 in the ordinary kind), the
  // row comes from ContestMons and the level from that row's span.
  tryContestEncounter(collision: any): boolean {
    const game = this.game;
    const save = this.game ? this.game.save : undefined;
    if (!(game && save)) return false;
    if (!truthy(BugContest.triggers(Permissions.isSuperTallGrass(collision)))) {
      return false;
    }
    const roll = this.rollEncounter("contest", "grass", undefined, rollContestVanilla);
    if (!truthy(roll)) return false;
    const wild = Mon.new(game.data, roll.species, roll.level);
    if (!truthy(wild)) return false;
    save.pokedex = save.pokedex ?? { seen: {}, caught: {} };
    save.pokedex.seen[roll.species] = true;
    // BATTLETYPE_CONTEST, which is what puts PARKBALL in the battle menu and
    // sends a caught mon to wContestMon instead of to the party.
    this.startBattle({ wild, contest: true });
    return true;
  }

  // Lua: World.lua:4647-4690 -- CheckTimeEvents (engine/overworld/events.asm),
  // the clock half of the player-event chain. While ENGINE_BUG_CONTEST_TIMER
  // is set it polls CheckBugContestTimer and NOTHING else. `.do_daily` is
  // CheckDailyResetTimer, CheckSwarmFlag, CheckPokerusTick and CheckPhoneCall,
  // in the cart's order. The reset clears wDailyFlags1, which makes the
  // contest a ONCE A DAY thing. CheckPhoneCall is the random incoming ring
  // (Phone.tryRandomCall's five-test gate); what belongs here is only what the
  // gate reads off the world: CheckStandingOnEntrance (home/map_objects.asm) is
  // COLL.DOOR / COLL_DOOR_79 / COLL_STAIRCASE / COLL_CAVE under the player.
  checkTimeEvents(): any {
    const save = this.game ? this.game.save : undefined;
    if (!save) return false;
    if (!truthy(BugContest.isActive(save))) {
      // The daily reset, the swarms, Pokerus and the phone's call timer all
      // run on minutes and days: once a second answers them as the cart's
      // every frame does, at a fraction of the cost (they were half an
      // overworld step under QuickJS). The contest's timer below still
      // ticks every step.
      const second = osTime();
      if (second === this.timeEventsSecond) return false;
      this.timeEventsSecond = second;
      Apricorns.checkDailyResetTimer(save, undefined,
        this.engineFlagResolver ? this.engineFlagResolver() : undefined);
      // CheckSwarmFlag, second on `.do_daily` and the ONLY thing that ever
      // ends a swarm: the reset above takes DAILYFLAGS1_SWARM down, and this is
      // what notices and clears wSwarmMapGroup/Number and wFishingSwarmFlag.
      Roamers.Swarm.check(save);
      Pokerus.checkTick(save);
      const ctx = this.stepContext().phone;
      const coll = this.map && this.player
        ? this.map.cellCollision(this.player.cellX, this.player.cellY) : undefined;
      ctx.standingOnEntrance = coll === 0x71 || coll === 0x79
        || coll === 0x7a || coll === 0x7b;
      const call = Phone.checkPhoneCall(save, ctx);
      if (truthy(call)) return this.receivePhoneCall(call);
      return false;
    }
    if (!truthy(BugContest.tickTimer(save))) return false;
    return this.bugContestOver("time");
  }

  /** The clock second checkTimeEvents last ran its daily checks in. */
  private timeEventsSecond = -1;

  // Lua: World.lua:4702-4712
  bugContestOver(reason: string): boolean {
    if (this.bugContestEnding) return false;
    this.bugContestEnding = true;
    this.playSfxNamed("Sfx_ElevatorEnd", SFX_ELEVATOR_END);
    const line = reason === "balls" ? BUG_CONTEST_IS_OVER : BUG_CONTEST_TIME_UP;
    this.showText(Strings.get(line), () => {
      this.bugContestEnding = undefined;
      this.bugContestResults();
    });
    return true;
  }

  // Lua: World.lua:4714-4726 -- `jumpstd BugContestResultsWarpScript`, run the
  // way the cart runs it: the std script itself does the warp to the north
  // gate, the walk in, the judging, the prize and the party hand-back. A cache
  // without that std script leaves the contest state alone -- stopping the
  // clock here would strand the player in the park with no way to be judged.
  bugContestResults(): any {
    const entry = this.stdScripts && this.stdScripts.scripts
      ? this.stdScripts.scripts.BugContestResultsWarpScript : undefined;
    const key = entry ? entry.key : undefined;
    if (!(truthy(key) && this.vm)) return false;
    return this.vm.start(key);
  }

  // Lua: World.lua:4728-4738 -- BugCatchingContestBattleScript's tail:
  // `readmem wParkBallsRemaining / iffalse BugCatchingContestOutOfBallsScript`,
  // checked on the way out of every contest battle.
  bugContestBattleOver(): boolean {
    const save = this.game ? this.game.save : undefined;
    if (!save) return false;
    if (!truthy(BugContest.isActive(save))) return false;
    if (!truthy(BugContest.isOver(save))) return false;
    return this.bugContestOver("balls");
  }

  // Lua: World.lua:4740-4749 -- true when `itemId` is one of the three rods.
  // The item table is consulted when the caller has one, so a cache whose
  // ItemNames sit at other indices refuses rather than fishing with a BICYCLE.
  static isRod(itemId: any, items?: any): boolean {
    const index = ROD_INDEX[itemId];
    if (index == null) return false;
    const def = items ? items[itemId] : undefined;
    if (def && truthy(def.index) && def.index !== index) return false;
    return true;
  }

  // Lua: World.lua:4751-4829 -- FishFunction's .TryFish
  // (engine/events/overworld.asm): the roll on its own, with no animation and
  // no battle. Returns the Lua's two values as [outcome, wild]:
  //   "nowhere"  $3 .FailFish          surfing, or not facing water
  //   "nofish"   $4 .FishNoFish        facing water the map has no group for
  //   "nibble"   $1 .FishNoBite        the group's own roll came up empty
  //   "battle"   $2 .FishGotSomething  (wild is the hooked mon)
  // Split out of World:tryFishing because Script_GotABite writes RodBiteText
  // BEFORE its startbattle, so the cast runs between the roll and the battle.
  rollFishing(rod: any): [FishOutcome, any?] {
    const game = this.game;
    const player = this.player;
    const map = this.map;
    if (!(game && player && map && this.encounters)) return ["nowhere"];
    // .TryFish reads wPlayerState first and drops straight to $3 .FailFish
    // while the player is PLAYER_SURF / PLAYER_SURF_PIKA.
    if (truthy(FieldMoves.isSurfing(this.playerState))) return ["nowhere"];
    // The cart requires the tile the player is FACING to be water.
    const d = Map.DELTA[player.facing ?? "down"] ?? Map.DELTA.down!;
    const cx = player.cellX + d[0];
    const cy = player.cellY + d[1];
    if (!truthy(Permissions.isWater(map.cellCollision(cx, cy)))) return ["nowhere"];
    // GetFishingGroup (home/map.asm) is MAP_FISHGROUP off the map header, and
    // .facingwater's `and a / jr nz` sends FISHGROUP_NONE to .FishNoFish. The
    // Encounter helper defaults an unknown map to the pond, so the header is
    // read here rather than left to it.
    const def = this.maps ? this.maps[map.id] : undefined;
    const group = def ? def.fishGroup : undefined;
    if (!truthy(group) || group === 0 || group === "FISHGROUP_NONE") {
      return ["nofish"];
    }
    // GetFishGroupIndex reads wFishingSwarmFlag between the header and the
    // FishGroups index, which is how the Route 32 Qwilfish and Route 44
    // Remoraid swarms reach the rods at all.
    const swarm = Roamers.Swarm.fishing(game.save);
    // engine/events/fish.asm:24-30
    const groupRow = this.encounters.fishGroups
      ? this.encounters.fishGroups[
        Encounter.fishGroupFor(this.encounters, group, swarm)] : undefined;
    if (groupRow && groupRow.chance != null
        && !truthy(Encounter.triggers(groupRow.chance, undefined))) {
      return ["nibble"];
    }
    let roll: any;
    const tod = this.tod ?? "DAY";
    if (Runtime.wantsHook("encounter.fishing")) {
      // Gen 1's three arguments, in Gen 1's order: the rod, the map, and the
      // candidate list (the FishGroups row the map header, plus any swarm swap,
      // resolves to). ctx is the fourth argument and is Gen 2's alone.
      const group2 = Encounter.fishGroupFor(this.encounters,
        (def && truthy(def.fishGroup)) ? def.fishGroup : "FISHGROUP_POND", swarm);
      const groups = this.encounters ? this.encounters.fishGroups : undefined;
      roll = Runtime.call("encounter.fishing", fishVanilla, rod, map.id,
        groups ? groups[group2] : undefined,
        { fishGroup: group2, swarm, encounters: this.encounters,
          maps: this.maps, data: game.data, tod, daytime: tod });
    } else {
      roll = Encounter.fishSlot(this.encounters, map.id, rod, undefined, this.maps,
        swarm, tod);
    }
    if (!truthy(roll) || !truthy(roll.species)) return ["nibble"];
    const wild = Mon.new(game.data, roll.species, roll.level);
    if (!truthy(wild)) return ["nibble"];
    const save = game.save;
    if (save) {
      save.pokedex = save.pokedex ?? { seen: {}, caught: {} };
      save.pokedex.seen[roll.species] = true;
    }
    return ["battle", wild];
  }

  // Lua: World.lua:4831-4845 -- roll and start the battle in one call, for a
  // caller that wants the outcome without the cast animation. The PACK goes
  // through World:useRod instead. "nowhere" and "nofish" differ: the PACK
  // stays open for one and quits for the other.
  tryFishing(rod: any): FishOutcome {
    const [outcome, wild] = this.rollFishing(rod);
    if (outcome === "battle" && truthy(wild)) {
      this.startBattle({ wild });
    }
    return outcome;
  }

  // Lua: World.lua:4847-4860 -- UseRod (engine/items/item_effects.asm), a bare
  // `farcall FishFunction`. A rod is ITEMMENU_NOUSE in battle, and a running
  // script owns the world, so both answer "nowhere" -- the cart's own "This
  // isn't the time to use that!", the case where the PACK stays open.
  useRod(rodId: any): FishOutcome {
    if (truthy(this.battleActive) || truthy(this.busy())) return "nowhere";
    const [outcome, wild] = this.rollFishing(rodId);
    if (outcome === "nowhere") return "nowhere";
    this.beginFishing(outcome, wild);
    return outcome;
  }

  // Lua: World.lua:4862-4884 -- the field half of engine/items/pack.asm
  // UseItem: an item used from the PACK in the overworld. The Lua's results
  // come back as [outcome, extra]: outcome undefined for anything this world
  // does not handle (the PACK falls through to its own onChoose), otherwise
  // the sentinel ("nowhere" = the PACK stays open and prints
  // OakThisIsntTheTimeText); `extra` is the count for coin_case / blue_card.
  useFieldItem(itemId: any): [string | undefined, any?] {
    const items = this.game && this.game.data ? this.game.data.items : undefined;
    if (itemId === "ITEMFINDER") return [this.useItemfinder()];
    if (itemId === "BICYCLE") return [this.useBike(itemId)];
    if (itemId === "SACRED_ASH") return [this.useSacredAsh()];
    if (itemId === "ESCAPE_ROPE") return [this.useEscapeRope(itemId)];
    if (itemId === "SQUIRTBOTTLE") return [this.useSquirtbottle()];
    // CoinCaseEffect (engine/items/item_effects.asm:2243).
    if (itemId === "COIN_CASE") return ["coin_case", this.coins()];
    // BlueCardEffect (../pokecrystal/engine/items/item_effects.asm:2251).
    if (itemId === "BLUE_CARD") {
      return ["blue_card", this.readVar(VAR.BLUECARDBALANCE)];
    }
    if (REPEL_STEPS[itemId] != null) return [this.useRepel(itemId)];
    if (truthy(TROPHY_BOXES[itemId])) return [this.openTrophyBox(itemId)];
    if (!World.isRod(itemId, items)) return [undefined];
    return [this.useRod(itemId)];
  }

  // Lua: World.lua:4886-4903 -- EscapeRopeOrDig's .CheckCanDig
  // (engine/events/overworld.asm): the map's environment must be CAVE or
  // DUNGEON and the banked warp triple must name a real warp. This port keeps
  // one banked triple -- backupWarp, the same store a -1 warp destination
  // resolves through and the one the save carries. A triple that names a map
  // or warp the cache does not carry is the cart's zeroed-triple `.fail` arm.
  // Returns the Lua's two values as [destMapId, destWarp], or undefined where
  // the Lua returns nil (so `escapeRopeTarget() != null` reads as the Lua's
  // `~= nil`).
  escapeRopeTarget(): [string, any] | undefined {
    const env = this.map && this.map.def ? this.map.def.environment : undefined;
    if (env !== "CAVE" && env !== "DUNGEON") return undefined;
    const backup = this.backupWarp;
    const dest = backup && truthy(backup.map) && this.maps ? this.maps[backup.map] : undefined;
    // backup.warp is the 1-based warp number; dest.warps is 0-based.
    const destWarp = dest && dest.warps && truthy(backup.warp)
      ? dest.warps[backup.warp - 1] : undefined;
    if (!truthy(destWarp)) return undefined;
    return [backup.map, destWarp];
  }

  // Lua: World.lua:4905-4925 -- .UsedDigScript,
  // engine/events/overworld.asm:851-872; engine/overworld/events.asm:1034
  runEscapeWarp(destMapId: any, destWarp: any): boolean {
    this.playSfxNamed("Sfx_WarpTo", SFX.WARP_TO);
    const load = (): any => {
      this.applyPlayerState(FieldMoves.PLAYER_NORMAL);
      const ok = this.runMapSetup(MAPSETUP.DOOR, () => {
        const loaded = this.setMap(destMapId, destWarp.x, destWarp.y, "down");
        if (truthy(loaded)) this.spawnFacing();
        return loaded;
      });
      if (this.mapSetup) {
        this.mapSetup.digIn = true;
      } else {
        this.digReturn();
      }
      return ok;
    };
    this.beginMovement(0, Movement.digOutBytes(), load);
    return true;
  }

  // Lua: World.lua:4927-4931 -- the half after `newloadmap`:
  // engine/events/overworld.asm:869-870
  digReturn(): void {
    this.playSfxNamed("Sfx_WarpFrom", SFX.WARP_FROM);
    this.beginMovement(0, Movement.digReturnBytes());
  }

  // Lua: World.lua:4933-4956 -- EscapeRopeEffect
  // (engine/items/item_effects.asm): EscapeRopeFunction, and
  // UseDisposableItem only when it succeeded -- a refusal costs nothing.
  // "nowhere" sends UseItem's .Field arm to .Oak; a success quits the PACK,
  // with the queued script running once the overworld owns the frame (the
  // QueueScript placement the cart gives .UsedEscapeRopeScript).
  useEscapeRope(itemId?: any): string {
    if (truthy(this.battleActive) || truthy(this.busy())) return "nowhere";
    const target = this.escapeRopeTarget();
    if (!target) return "nowhere";
    const [destMapId, destWarp] = target;
    const items = this.game && this.game.data ? this.game.data.items : undefined;
    const def = items ? items[itemId ?? "ESCAPE_ROPE"] : undefined;
    this.takeItem(def ? def.index : undefined, 1);
    // ../pokecrystal/engine/events/overworld.asm:809, between .escaperope and
    // QueueScript.
    UnownWords.kabutoChamber(this.events, this.map ? this.map.id : undefined);
    this.queuedFieldMove = {
      ok: true, action: "escaperope",
      destMap: destMapId, destWarp,
      text: FieldMoves.TEXT.USE_ESCAPE_ROPE,
    };
    return "escape_rope";
  }

  // Lua: World.lua:4958-5002 -- _Squirtbottle's WateredWeirdTreeScript rows,
  // sliced out of the Sudowoodo talk script (see SPRITEMOVEDATA_SUDOWOODO), or
  // undefined when the player is not facing the tree.
  squirtbottleTreeScript(): any[] | undefined {
    const p = this.player;
    const map = this.map;
    if (!(p && map && map.id === "ROUTE_36")) return undefined;
    const d = Map.DELTA[p.facing ?? "down"] ?? Map.DELTA.down!;
    const npc = this.npcAt(p.cellX + d[0], p.cellY + d[1]);
    const def = npc ? npc.def : undefined;
    if (!(def && def.movement === SPRITEMOVEDATA_SUDOWOODO
        && truthy(def.scriptKey))) {
      return undefined;
    }
    const talk = this.scripts ? this.scripts[def.scriptKey] : undefined;
    let armKey: any;
    for (const cmd of talk ?? []) {
      if (cmd.op === "iftrue" && truthy(cmd.script)) { armKey = cmd.script; break; }
    }
    const arm = truthy(armKey) && this.scripts ? this.scripts[armKey] : undefined;
    if (!arm) return undefined;
    for (let i = 0; i < arm.length; i++) {
      const cmd = arm[i];
      if (cmd.op === "iffalse") {
        // WateredWeirdTreeScript starts past the yesorno's own closetext.
        let start = i + 1;
        if (arm[start] && arm[start].op === "closetext") start = start + 1;
        if (!arm[start]) return undefined;
        const rows: any[] = [];
        for (let j = start; j < arm.length; j++) rows.push(arm[j]);
        return rows;
      }
    }
    return undefined;
  }

  // Lua: World.lua:5004-5019 -- _Squirtbottle (engine/events/squirtbottle.asm):
  // the script is QUEUED and wItemEffectSucceeded is set unconditionally, so
  // the PACK always quits; .CheckCanUseSquirtbottle then picks between
  // WateredWeirdTreeScript and the "nothing happened" line. The check runs at
  // queue time, because the player cannot turn between the press and the drain.
  useSquirtbottle(): string {
    if (truthy(this.battleActive) || truthy(this.busy())) return "nowhere";
    const tree = this.squirtbottleTreeScript();
    if (tree) {
      this.queuedScript = tree;
    } else {
      this.queuedScript = [
        { op: "opentext" },
        { op: "rawtext", text: TEXT_SQUIRTBOTTLE_NOTHING },
        { op: "waitbutton" },
        { op: "closetext" },
        { op: "end" },
      ];
    }
    return "squirtbottle";
  }

  // Lua: World.lua:5021-5044 -- CheckRegisteredItem
  // (engine/overworld/select_menu.asm), re-run on every SELECT press: running
  // out of the item answers the same ".NoRegisteredItem" way the cart does --
  // silently clearing the slot. This port keeps only the item id and re-reads
  // the live inventory count.
  registeredItemId(): any {
    const save = this.game ? this.game.save : undefined;
    const reg = save ? save.registeredItem : undefined;
    const id = reg ? reg.id : undefined;
    if (!truthy(id)) return undefined;
    const items = this.game && this.game.data ? this.game.data.items : undefined;
    const def = items ? items[id] : undefined;
    const count = save.inventory ? save.inventory[id] : undefined;
    if (!def || def.canSelect === false || count == null || count <= 0) {
      save.registeredItem = undefined;
      return undefined;
    }
    return id;
  }

  // Lua: World.lua:5046-5059 -- RegisterItem (engine/items/pack.asm):
  // CheckSelectableItem gates it, the same ITEMATTR_PERMISSIONS bit
  // `registeredItemId` re-checks on use. PackMenu calls it straight off the
  // highlighted row on a SELECT press (the cart's row submenu is not built).
  registerItem(itemId: any): boolean {
    const items = this.game && this.game.data ? this.game.data.items : undefined;
    const def = items ? items[itemId] : undefined;
    const save = this.game ? this.game.save : undefined;
    if (!save || !def || def.canSelect === false) return false;
    save.registeredItem = { id: itemId };
    return true;
  }

  // Lua: World.lua:5061-5080 -- SelectMenu (engine/overworld/select_menu.asm):
  // the SELECT press in the overworld, the same dispatch `useFieldItem` runs
  // for the PACK's own UseItem with "no registered item" and "no field handler"
  // as the two extra outcomes. Returns the Lua's two values as
  // [outcome, itemId].
  useSelectItem(): [string, any?] {
    if (truthy(this.battleActive) || truthy(this.busy())) return ["nowhere"];
    const id = this.registeredItemId();
    if (!truthy(id)) return ["not_registered"];
    // wUsingItemWithSelect, set for exactly the length of the effect: the
    // BICYCLE is the one item whose effect reads it (.CheckIfRegistered).
    this.usingItemWithSelect = true;
    const [outcome] = this.useFieldItem(id);
    this.usingItemWithSelect = undefined;
    if (outcome == null) return ["cant_use"];
    return [outcome, id];
  }

  // Lua: World.lua:5082-5108 -- UseRepel (engine/items/item_effects.asm): a
  // REPEL is ITEMMENU_CURRENT, so the PACK never quits for it, win or lose.
  // wRepelEffect already set prints RepelUsedEarlierIsStillInEffectText and
  // leaves the counter and the bag alone; otherwise the new count is written
  // and UseDisposableItem removes one. PackMenu owns both messages. A REPEL is
  // ITEMMENU_NOUSE in battle, so the in-battle PACK is refused here too.
  useRepel(itemId: any): string | undefined {
    const save = this.game ? this.game.save : undefined;
    if (!save) return undefined;
    if (truthy(this.battleActive) || truthy(this.busy())) return "nowhere";
    if ((save.repelSteps ?? 0) > 0) return "repel_active";
    save.repelSteps = REPEL_STEPS[itemId];
    if (save.inventory) {
      const left = (save.inventory[itemId] ?? 1) - 1;
      // Lua `= left > 0 and left or nil`: nil removes the key.
      if (left > 0) save.inventory[itemId] = left;
      else delete save.inventory[itemId];
    }
    return "repel_used";
  }

  // Lua: World.lua:5110-5131 -- NormalBoxEffect / GorgeousBoxEffect
  // (engine/items/item_effects.asm): SetSpecificDecorationFlag,
  // _SentTrophyHomeText, UseDisposableItem. Both are ITEMMENU_CURRENT, so the
  // PACK prints and stays open; ITEMMENU_NOUSE in battle.
  openTrophyBox(itemId: any): string | undefined {
    const decoFlag = TROPHY_BOXES[itemId];
    if (!truthy(decoFlag)) return undefined;
    if (truthy(this.battleActive)) return "nowhere";
    Decorations.giveFlag(this.events, decoFlag);
    const items = this.game && this.game.data ? this.game.data.items : undefined;
    const def = items ? items[itemId] : undefined;
    this.takeItem(def ? def.index : undefined, 1);
    return "trophy_sent";
  }

  // Lua: World.lua:5133-5152 -- ItemFinder (engine/items/itemfinder.asm):
  // CheckForHiddenItems, then one of two scripts is QUEUED and
  // wItemEffectSucceeded is set unconditionally: in the FIELD the ITEMFINDER
  // always quits the PACK. ITEMMENU_NOUSE in battle, where no script is
  // queued. QueueScript, not CallScript: the beeps and the line belong over
  // the overworld; World:runQueuedScript is the other half.
  useItemfinder(): string {
    if (truthy(this.battleActive)) return "nowhere";
    const p = this.player;
    const near = p ? HiddenItems.nearby(
      this.map ? this.map.def : undefined, p.cellX, p.cellY, this.events) : undefined;
    const found = truthy(near) ? near : undefined;
    this.queuedScript = HiddenItems.itemfinderScript(found, (want: any, id: any) =>
      this.sfxIdNamed(want, id));
    return "itemfinder";
  }

  // ---------------------------------------------------------------- the bike
  // Lua: World.lua:5154-5157 -- src/world/gen2/Bike.lua owns every decision;
  // this is the world state those decisions read and the presentation they
  // end in.

  // Lua: World.lua:5159-5175 -- ../pokecrystal/constants/engine_flags.asm:25
  // ENGINE_MOBILE_SYSTEM shifts every later id up one: :36 ALWAYS_ON_BIKE
  // against ../pokegold's :35. The id is the name's 0-based position in
  // constants.engineFlagOrder (the Lua's `index - 1`).
  engineFlagId(name: string, goldId: any): any {
    const order = this.constants ? this.constants.engineFlagOrder : undefined;
    if (order === null || typeof order !== "object") return goldId;
    let ids: Record<string, number> | undefined = this.engineFlagIds;
    if (!ids) {
      ids = {};
      if (Array.isArray(order)) {
        for (let i = 0; i < order.length; i++) {
          if (typeof order[i] === "string") ids[order[i]] = i;
        }
      } else {
        for (const k of Object.keys(order)) {
          const index = Number(k);
          if (Number.isInteger(index) && typeof order[k] === "string") ids[order[k]] = index - 1;
        }
      }
      this.engineFlagIds = ids;
    }
    return ids[name] ?? goldId;
  }

  // Lua: World.lua:5177-5184
  engineFlagResolver(): (name: string, goldId: any) => any {
    let fn = this.engineFlagResolverFn;
    if (!fn) {
      fn = (name: string, goldId: any) => this.engineFlagId(name, goldId);
      this.engineFlagResolverFn = fn;
    }
    return fn;
  }

  // Lua: World.lua:5186-5197 -- Unown.UNLOCK_SETS keys the flags by pokegold's
  // ids; Crystal's are one higher (../pokecrystal/constants/engine_flags.asm:
  // 57-60 vs ../pokegold:56-59).
  unownUnlockFlags(): Record<number, boolean> {
    const engine = this.engineFlags();
    const out: Record<number, boolean> = {};
    for (const set of Unown.UNLOCK_SETS) {
      if (truthy(engine[this.engineFlagId(set.name, set.flag)])) {
        out[set.flag] = true;
      }
    }
    return out;
  }

  // Lua: World.lua:5199-5205 -- wBikeFlags' three bits are ENGINE_* ids like
  // any other flag, so the map callbacks that set them
  // (Route16AlwaysOnBikeCallback, Route17AlwaysOnBikeCallback) already land on
  // save.engineFlags.
  alwaysOnBike(): any {
    return this.engineFlag(this.engineFlagId(
      "ENGINE_ALWAYS_ON_BIKE", Bike.ENGINE_ALWAYS_ON_BIKE));
  }

  // Lua: World.lua:5207-5210
  downhill(): any {
    return this.engineFlag(this.engineFlagId(
      "ENGINE_DOWNHILL", Bike.ENGINE_DOWNHILL));
  }

  // ---------------------------------------------------------------------------
  // W4: World.lua:5213-6899
  // ---------------------------------------------------------------------------

  // Lua: World.lua:5213-5217
  playerCollision(): any {
    const p = this.player;
    if (!(p && this.map)) return undefined;
    return this.map.cellCollision(p.cellX, p.cellY);
  }

  // Lua: World.lua:5219-5258 -- BikeFunction (engine/events/overworld.asm),
  // reached from BicycleEffect. The BICYCLE is ITEMMENU_CLOSE, so UseItem
  // takes its .Field arm: a non-zero wFieldMoveSucceeded quits the PACK and
  // lets the queued script run in the overworld, a zero drops into .Oak.
  // "nowhere" is that zero (PackMenu prints OakThisIsntTheTimeText for it);
  // the three other answers all queue a script and let the PACK close.
  //
  // .GetOnBike's music silences the current song, plays MUSIC_BICYCLE and
  // writes it into wMapMusic, so the bike theme survives until the
  // dismount's `special PlayMapMusic` or the next map load.
  useBike(itemId?: string): string {
    if (truthy(this.battleActive) || truthy(this.busy())) return "nowhere";
    const items = this.game && this.game.data ? this.game.data.items : undefined;
    const def = items ? items[itemId ?? "BICYCLE"] : undefined;
    const item = def ? def.index : undefined;
    const specialId = (name: string): any => this.specialIdNamed(name);
    const action = Bike.tryBike({
      state: this.playerState,
      environment: this.map && this.map.def ? this.map.def.environment : undefined,
      collision: this.playerCollision(),
      alwaysOnBike: this.alwaysOnBike(),
    });
    // wUsingItemWithSelect, which .CheckIfRegistered reads to pick the silent
    // pair of scripts.
    const silent = truthy(this.usingItemWithSelect);
    if (action === "mount") {
      this.queuedScript = Bike.mountScript(item, specialId, silent);
      this.playBikeMusic();
      return "bike_on";
    } else if (action === "dismount") {
      this.queuedScript = Bike.dismountScript(item, specialId, silent);
      return "bike_off";
    } else if (action === "cant_get_off") {
      this.queuedScript = Bike.cantGetOffScript();
      return "bike_stuck";
    }
    return "nowhere";
  }

  // Lua: World.lua:5260-5270
  playBikeMusic(): boolean {
    const data = this.game ? this.game.data : undefined;
    const audio = data ? data.audio : undefined;
    if (!(audio && truthy(audio.runtime))) return false;
    if (!(audio.songs && truthy(audio.songs[Bike.MUSIC_BICYCLE]))) return false;
    // engine/events/overworld.asm:1621-1630
    Music.stop();
    Music.setMapSong(Bike.MUSIC_BICYCLE);
    Music.play(data, Bike.MUSIC_BICYCLE, true, { reason: "bike" });
    return true;
  }

  // Lua: World.lua:5272-5283 -- `special` names resolve through the cache's
  // own SpecialsPointers order (constants.specialOrder), same as
  // Vm:specialName but from the name: the 0-based special id, or undefined.
  specialIdNamed(name?: string): number | undefined {
    const order = this.constants ? this.constants.specialOrder : undefined;
    if (!order || name == null) return undefined;
    for (let i = 0; i < order.length; i++) {
      if (order[i] === name) return i;
    }
    return undefined;
  }

  // Lua: World.lua:5285-5334 -- SacredAshEffect / _SacredAsh
  // (engine/items/item_effects.asm, engine/events/sacred_ash.asm).
  // CheckAnyFaintedMon gates the whole effect: an empty party or one with
  // nothing fainted falls through to .Oak ("nowhere") with the item untouched.
  // On success SacredAshScript runs a single HealParty behind three
  // Pokecenter-style fade cycles and the "all healed" line, then
  // UseDisposableItem removes the one Ash from the bag.
  useSacredAsh(): string {
    if (truthy(this.battleActive) || truthy(this.busy())) return "nowhere";
    const save = this.game ? this.game.save : undefined;
    const party: any[] = (save && save.party) || [];
    let anyFainted = false;
    for (const mon of party) {
      if (!truthy(Breeding.isEgg(mon)) && (mon.hp ?? 0) <= 0) {
        anyFainted = true;
        break;
      }
    }
    if (!anyFainted) return "nowhere";

    if (save.inventory) {
      const left = (save.inventory.SACRED_ASH ?? 1) - 1;
      if (left > 0) save.inventory.SACRED_ASH = left;
      else delete save.inventory.SACRED_ASH;
    }

    const script: any[] = [
      { op: "special", id: this.specialIdNamed("HealParty") },
      { op: "refreshmap" },
      { op: "playsound", id: this.sfxIdNamed("Sfx_WarpTo", SFX.WARP_TO) },
    ];
    for (let n = 1; n <= 3; n++) {
      script.push({ op: "special", id: this.specialIdNamed("FadeOutToWhite") });
      script.push({ op: "special", id: this.specialIdNamed("FadeInFromWhite") });
    }
    script.push({ op: "waitsfx" });
    script.push({ op: "opentext" });
    script.push({ op: "rawtext", text: TEXT_USE_SACRED_ASH });
    script.push({ op: "playsound", id: this.sfxIdNamed("Sfx_CaughtMon", 2) });
    script.push({ op: "waitsfx" });
    script.push({ op: "waitbutton" });
    script.push({ op: "closetext" });
    script.push({ op: "end" });
    this.queuedScript = script;
    return "sacredash";
  }

  // Lua: World.lua:5336-5348 -- QueueScript's drain, on the same clock as the
  // field move one below it: the first frame the overworld owns after the
  // menus are gone.
  runQueuedScript(): any {
    const script = this.queuedScript;
    if (!truthy(script) || truthy(this.busy())) return false;
    this.queuedScript = undefined;
    this.talkNpc = undefined;
    const vm = this.vm;
    if (vm && typeof script === "object" && script.phoneContact != null) {
      vm.curPhoneCaller = script.phoneContact;
    }
    if (vm) {
      const started = vm.start(script);
      if (truthy(started)) return started;
    }
    return false;
  }

  // Lua: World.lua:5350-5380 -- Script_FishCastRod, then
  // Script_NotEvenANibble or Script_GotABite, held as an exact 60 Hz frame
  // counter.
  beginFishing(outcome?: any, wild?: any): void {
    const p = this.player;
    const d = Map.DELTA[(p && p.facing) || "down"] ?? Map.DELTA.down!;
    const targetCellX = p ? (p.cellX + d[0]) : 0;
    const targetCellY = p ? (p.cellY + d[1]) : 0;
    const bobber = {
      cellX: targetCellX,
      cellY: targetCellY,
      px: targetCellX * 16,
      py: targetCellY * 16,
    };
    this.fishing = {
      phase: "cast",
      timer: FISH_CAST_FRAMES,
      outcome,
      wild,
      bobber,
      facing: (p && p.facing) || "down",
    } as FishingState;
    if (this.player) {
      this.player.fishing = true;
      this.player.fishingState = this.fishing;
      // LoadFishingGFX reads wPlayerGender
      // (../pokecrystal/engine/events/fishing_gfx.asm:8-12)
      this.player.fishSheet =
        (truthy(FieldMoves.isFemale(this.playerGender())) && truthy(this.fishingSheetFemale))
          ? this.fishingSheetFemale : this.fishingSheet;
    }
  }

  // Lua: World.lua:5382-5432
  updateFishing(): void {
    const st: FishingState | undefined = this.fishing;
    if (!st) return;
    if (this.player) this.player.fishingState = st;
    // A text box owns the frame while it is up; the script only moves on when
    // its own callback fires.
    if (this.textbox || this.choicebox) return;
    if (st.timer > 0) {
      st.timer = st.timer - 1;
      // StepFunction_GotBite (engine/overworld/map_objects.asm:1430) is one
      // byte of animation: OBJECT_SPRITE_Y_OFFSET flipped between 0 and 1 once
      // a frame for the length of the bite -- the rod jerking.
      if (this.player) {
        this.player.spriteYOffset =
          (st.phase === "bite" && mod(st.timer, 2) === 1) ? 1 : 0;
      }
      return;
    }
    if (this.player) this.player.spriteYOffset = 0;
    if (st.phase === "cast") {
      if (st.outcome === "battle") {
        st.phase = "bite";
        st.timer = FISH_BITE_FRAMES;
        this.showEmote(EMOTE_SHOCK, 0, FISH_BITE_FRAMES);
        return;
      }
      st.phase = "done";
      this.showText(Strings.get(TEXT_ROD_NOTHING), () => {
        this.fishing = undefined;
        if (this.player) {
          this.player.fishing = undefined;
          this.player.fishingState = undefined;
        }
      });
      return;
    }
    if (st.phase === "bite") {
      st.phase = "done";
      this.showText(Strings.get(TEXT_ROD_BITE), () => {
        const wild = st.wild;
        this.fishing = undefined;
        if (this.player) {
          this.player.fishing = undefined;
          this.player.fishingState = undefined;
        }
        if (truthy(wild)) this.startBattle({ wild, battleType: "fish" });
      });
      return;
    }
  }

  // Lua: World.lua:5434-5438 -- CheckHeadbuttTreeTile (home/map_objects.asm).
  static isHeadbuttTree(coll: any): boolean {
    if (coll == null) return false;
    return HEADBUTT_TREE[mod(coll, 256)] === true;
  }

  // Lua: World.lua:5440-5457 -- CheckPartyMove (engine/events/overworld.asm):
  // the first party mon that knows `moveId`. The cart leaves that mon's slot
  // in wCurPartyMon, which GetPartyNickname reads for "<nickname> did a
  // HEADBUTT!", so the mon itself is returned. HEADBUTT's and ROCK SMASH's
  // CheckPartyMove, wrapped in the fieldmove.eligibility chain
  // FieldMoves.partyMoveUser offers, with the full ctx.
  partyMoveUser(moveId: any): any {
    const save = this.game ? this.game.save : undefined;
    const party = (save && save.party) || [];
    return FieldMoves.partyMoveUser(party, moveId,
      { save, data: this.game ? this.game.data : undefined });
  }

  // Lua: World.lua:5459-5483 -- TryHeadbuttOW (engine/events/overworld.asm),
  // from TryTileCollisionEvent's .headbutt arm once the facing tile is a tree.
  // With no party mon that knows HEADBUTT the A press does nothing at all.
  // With one, AskHeadbuttScript opens. True when the event took the A press.
  tryHeadbuttOW(cx: number, cy: number): boolean {
    if (!(this.map && this.player)) return false;
    if (!World.isHeadbuttTree(this.map.cellCollision(cx, cy))) {
      return false;
    }
    const mon = this.partyMoveUser(MOVE_HEADBUTT);
    if (!truthy(mon)) return false;
    // AskHeadbuttScript: opentext, writetext AskHeadbuttText, yesorno,
    // iftrue HeadbuttScript. World:askYesNo re-shows the page it answers.
    this.showText(Strings.get(TEXT_ASK_HEADBUTT), () => {
      this.askYesNo((yes: any) => {
        if (truthy(yes)) this.runHeadbutt(cx, cy, mon);
      });
    });
    return true;
  }

  // Lua: World.lua:5485-5507 -- HeadbuttScript: GetPartyNickname,
  // UseHeadbuttText, ShakeHeadbuttTree, and only then TreeMonEncounter. The
  // roll comes AFTER the shake, which is why the tree rattles even when
  // nothing is home.
  runHeadbutt(cx: any, cy: any, mon: any): void {
    if (this.game) {
      // callasm GetPartyNickname: wStringBuffer2, read back as {STRBUF}.
      this.game.stringBuffer =
        (mon && (mon.nickname ?? mon.name ?? mon.species)) ?? "";
    }
    this.showText(Strings.get(TEXT_USE_HEADBUTT), () => {
      this.headbutt = { x: cx, y: cy, timer: HEADBUTT_SHAKE_FRAMES };
      // ShakeHeadbuttTree (engine/events/field_moves.asm:23) hides the BG tree
      // and wobbles an OBJ copy of it for 32 frames. The Lua had no per-block
      // OBJ layer, so the wobble is the frame's (earthquake), on the same
      // clock as the SFX; self.headbutt {x, y, timer} is what a renderer reads.
      this.earthquake(0x40, HEADBUTT_SHAKE_FRAMES);
      this.playSfx(SFX.SANDSTORM);
    });
  }

  // Lua: World.lua:5509-5522
  updateHeadbutt(): void {
    const st = this.headbutt;
    if (!st) return;
    if (this.textbox || this.choicebox) return;
    if (st.timer > 0) {
      st.timer = st.timer - 1;
      return;
    }
    // callasm TreeMonEncounter, iffalse .no_battle. Cleared first for the same
    // reason the fishing state is: startBattle must not see a busy world.
    this.headbutt = undefined;
    if (this.tryHeadbutt(st.x, st.y) === "battle") return;
    this.showText(Strings.get(TEXT_HEADBUTT_NOTHING));
  }

  // Lua: World.lua:5524-5531 -- ../pokecrystal/engine/events/treemons.asm:126
  // GetTreeMon's two RandomRange: 0..n-1.
  treeRandom(n: number): number {
    if (this.treemonRandom) return this.treemonRandom(n);
    return random(n) - 1;
  }

  // Lua: World.lua:5533-5560 -- Headbutt. A tree's own map entry decides
  // which of the two tree sets is rolled, and whether anything is home at all
  // (engine/events/treemons.asm TreeMonEncounter). "battle", "nothing" or
  // undefined.
  tryHeadbutt(cx: number, cy: number): "battle" | "nothing" | undefined {
    const game = this.game, map = this.map;
    if (!(game && map && this.encounters)) return undefined;
    const save = game.save;
    const engine = GameVersion.engine((save && save.version) || GameVersion.get());
    const roll = Encounter.treeSlot(this.encounters, map.id, cx, cy,
      (n: number) => this.treeRandom(n),
      { otId: (save && save.player && save.player.id) ?? 0, engine });
    if (!roll || !truthy(roll.species)) return "nothing";
    const wild = Mon.new(game.data, roll.species, roll.level);
    if (!wild) return "nothing";
    // LoadEnemyMon's .TreeMon arm (../pokecrystal/engine/battle/core.asm:6249)
    if (Encounter.treeMonAsleep(roll.species, this.tod ?? this.daytime ?? "DAY",
      engine, this.encounters)) {
      wild.status = "sleep";
      wild.statusTurns = Encounter.TREEMON_SLEEP_TURNS;
    }
    if (save) {
      save.pokedex = save.pokedex ?? { seen: {}, caught: {} };
      save.pokedex.seen[roll.species] = true;
    }
    this.startBattle({ wild, battleType: "tree" });
    return "battle";
  }

  // Lua: World.lua:5562-5587 -- ROCK SMASH's wild mon
  // (engine/events/treemons.asm RockMonEncounter), TreeMonEncounter's twin
  // over a different map table with a flat roll:
  //   GetTreeMonSet RockMonMaps   the four maps whose rocks hold anything
  //   GetTreeMons                 that row's TREEMON_SET_* table
  //   RandomRange 10, cp 4        40 percent, BETWEEN the two
  //   SelectTreeMon               the set's FIRST list, walked by a 0..99 roll
  // It writes no wScriptVar (RockSmashScript reads `readmem
  // wTempWildMonSpecies`), and never reaches GetTreeMon's `.rare` skip, so
  // only the 90/10 KRABBY / SHUCKLE list can come out of a rock. `random` is
  // injectable so a driver and a test can pin the 40 percent.
  rockRandom(n: number): number {
    if (this.rockmonRandom) return this.rockmonRandom(n);
    return random(n) - 1;
  }

  // Lua: World.lua:5589-5620 -- the species INDEX the cart leaves in
  // wTempWildMonSpecies, or 0 for nothing.
  rockMonEncounter(): number {
    // `xor a / ld [wTempWildMonSpecies], a / ld [wCurPartyLevel], a` opens the
    // routine, so a second smash never inherits the first one's mon.
    this.tempWildMon = undefined;
    const game = this.game, map = this.map;
    if (!(game && map && this.encounters)) return 0;
    const setName = this.encounters.rocks ? this.encounters.rocks[map.id] : undefined;
    if (!truthy(setName)) return 0;
    const set = this.encounters.treeSets ? this.encounters.treeSets[setName] : undefined;
    const list = set ? set.common : undefined;
    if (!(list && list.length > 0)) return 0;
    if (this.rockRandom(10) >= 4) return 0;
    // SelectTreeMon's `.loop: sub [hl] / jr c, .ok`: the chance column is
    // walked as a running total until the roll borrows.
    const value = this.rockRandom(100);
    let total = 0;
    let pick: any;
    for (const row of list) {
      total = total + (row.chance ?? 0);
      if (value < total) {
        pick = row;
        break;
      }
    }
    // `.ok`'s own `cp -1 / jr z, NoTreeMon`: a list walked off the end is nothing.
    if (!(pick && truthy(pick.species))) return 0;
    const pokemon = game.data ? game.data.pokemon : undefined;
    const def = pokemon ? pokemon[pick.species] : undefined;
    if (!(def && def.index != null)) return 0;
    this.tempWildMon = { species: def.index, level: pick.level };
    return def.index;
  }

  // Lua: World.lua:5630-5635
  tempWildMonSpeciesAddress(): number {
    const save = this.game ? this.game.save : undefined;
    const engine = GameVersion.engine((save && save.version) || GameVersion.get());
    return WRAM_TEMP_WILD_MON_SPECIES[engine] ?? WRAM_TEMP_WILD_MON_SPECIES.gs!;
  }

  // Lua: World.lua:5637-5642
  scriptReadMem(addr: any): number | undefined {
    if (addr === this.tempWildMonSpeciesAddress()) {
      return (this.tempWildMon && this.tempWildMon.species) ?? 0;
    }
    return undefined;
  }

  // Lua: World.lua:5644-5663 -- .SweetScent (engine/events/sweet_scent.asm):
  // UseSweetScentText, then SweetScentEncounter's roll. wFieldMoveSucceeded
  // was already set by FieldMoves.sweetScentFromMenu, so the only question
  // left is whether the encounter turns anything up, answered after the
  // button press, same as HEADBUTT's shake.
  runSweetScent(result: any): void {
    const mon = result ? result.mon : undefined;
    if (this.game) {
      // callasm GetPartyNickname: wStringBuffer2 (and 1 and 3) all hold the
      // same nickname, so {STRBUF} reads back UseSweetScentText's line.
      this.game.stringBuffer =
        (mon && (mon.nickname ?? mon.name ?? mon.species)) ?? "";
    }
    this.showText(Strings.get(TEXT_USE_SWEET_SCENT), () => {
      if (this.sweetScentEncounter()) return;
      this.showText(Strings.get(TEXT_SWEET_SCENT_NOTHING));
    });
  }

  // Lua: World.lua:5665-5735 -- SweetScentEncounter
  // (engine/events/sweet_scent.asm): the same CanEncounterWildMon gate a step
  // takes, but everything downstream skips its own percentage roll.
  // GetMapEncounterRate only has to come back NONZERO, and ChooseWildEncounter
  // / _BugContest then run unconditionally. CheckRepelEffect is never reached:
  // a REPEL stops a STEP from encountering, not SWEET SCENT.
  sweetScentEncounter(): boolean {
    const game = this.game, player = this.player, map = this.map;
    if (!(game && player && map && this.encounters)) return false;
    const save = game.save;
    if (!(save && save.party && save.party.length > 0)) return false;
    const collision = map.cellCollision(player.cellX, player.cellY);
    const environment = map.def ? map.def.environment : undefined;
    if (!truthy(FieldMoves.canEncounterWildMon(
      environment, collision, this.noWildEncounters))) {
      return false;
    }
    // .BugCatchingContest: `checkflag ENGINE_BUG_CONTEST_TIMER` skips
    // GetMapEncounterRate and goes straight to the park's own table; like the
    // step's contest arm, ChooseWildEncounter_BugContest never calls
    // CheckEncounterRoamMon.
    if (truthy(BugContest.isActive(save))) {
      const roll = this.rollEncounter("contest", "grass", undefined, rollContestVanilla);
      if (!truthy(roll)) return false;
      const wild = Mon.new(game.data, roll.species, roll.level);
      if (!wild) return false;
      save.pokedex = save.pokedex ?? { seen: {}, caught: {} };
      save.pokedex.seen[roll.species] = true;
      this.startBattle({ wild, contest: true });
      return true;
    }
    // Through ChooseWildEncounter like a step, so a swarm overrides the map's
    // list here too.
    const tables = this.wildTables();
    const onWater = FieldMoves.encounterTable(collision) === "water";
    // Lua `onWater and waterRate(...) or grassRate(...)`: a nil water rate
    // falls through to the grass one.
    let rate: any = onWater ? Encounter.waterRate(tables, map.id) : undefined;
    if (!truthy(rate)) rate = Encounter.grassRate(tables, map.id, this.tod);
    if (!(truthy(rate) && rate > 0)) return false;
    // CheckEncounterRoamMon, the first thing ChooseWildEncounter itself does:
    // a beast REPLACES the map's own slot rather than adding to it.
    const met: any = Roamers.checkEncounter(save, map.id, onWater, this.roamRandom());
    if (truthy(met)) {
      const beast = Roamers.beginBattle(save, met.index, game.data);
      if (truthy(beast)) {
        save.pokedex = save.pokedex ?? { seen: {}, caught: {} };
        save.pokedex.seen[beast.species] = true;
        this.startBattle({ wild: beast, roaming: met.index });
        return true;
      }
    }
    const roll = this.rollEncounter("sweet_scent", onWater ? "water" : "grass",
      tables, onWater ? rollWaterVanilla : rollGrassVanilla);
    if (!truthy(roll)) return false;
    // ChooseWildEncounter's Unown arm: a chamber with no puzzle solved yet
    // stays empty for SWEET SCENT too.
    let monOpts: any = undefined;
    if (roll.species === Unown.SPECIES) {
      const flags = this.unownUnlockFlags();
      if (!truthy(Unown.anyUnlocked(flags))) return false;
      // Mon.randomDVs returns Mon's Dvs (all optional); Unown reads the same four.
      monOpts = { dvs: Unown.wildDVs(flags, Mon.randomDVs as any) };
    }
    const wild = Mon.new(game.data, roll.species, roll.level, monOpts);
    if (!wild) return false;
    save.pokedex = save.pokedex ?? { seen: {}, caught: {} };
    save.pokedex.seen[roll.species] = true;
    this.startBattle({ wild });
    return true;
  }

  // ---- field moves ----------------------------------------------------------
  //
  // Lua: World.lua:5737-5744 -- the world half of engine/events/overworld.asm.
  // FieldMoves holds every decision (badge, party move, tile, refusal line);
  // this holds the effects, which need a map, a sprite and a frame clock. The
  // *Function routines are pure jumptable arithmetic and hand a SCRIPT to
  // QueueScript; the script touches the world.

  // Lua: World.lua:5746-5756 -- the index of the block cell (cx, cy) sits in,
  // plus the block id there: GetBlockLocation minus the WRAM border
  // arithmetic. Returns a TUPLE [index (1-based key), blockId] (the Lua's two
  // returns), or undefined off the map. Only fieldContext calls it.
  blockIndexAt(cx: number, cy: number): [number, any] | undefined {
    const map = this.map;
    if (!(map && map.width != null && map.height != null && map.def)) return undefined;
    const bx = Math.floor(cx / 2), by = Math.floor(cy / 2);
    if (bx < 0 || by < 0 || bx >= map.width || by >= map.height) return undefined;
    const index = by * map.width + bx + 1;
    return [index, (map.def.blocks ?? [])[index - 1]];
  }

  // Lua: World.lua:5758-5801 -- everything a FieldMoves routine reads,
  // gathered once. GetFacingTileCoord is folded in: the facing cell is the
  // player's own plus their direction, and wTileUp is the cell above them.
  fieldContext(mon?: any): any {
    const p = this.player, map = this.map;
    const save = this.game ? this.game.save : undefined;
    const facing = (p && p.facing) || "down";
    const d = Map.DELTA[facing] ?? Map.DELTA.down!;
    const fx = p.cellX + d[0], fy = p.cellY + d[1];
    const [blockIndex, blockId] = this.blockIndexAt(fx, fy) ?? [];
    return {
      save,
      party: (save && save.party) || [],
      mon,
      facing,
      facingX: fx, facingY: fy,
      facingColl: map.cellCollision(fx, fy),
      playerColl: map.cellCollision(p.cellX, p.cellY),
      // Crystal's SurfFunction.TrySurf is the only field move that asks
      // (../pokecrystal/engine/events/overworld.asm:364).
      facingObject: this.facingObject(),
      upColl: map.cellCollision(p.cellX, p.cellY - 1),
      tileset: map.def ? map.def.tileset : undefined,
      facingBlock: blockId,
      facingBlockIndex: blockIndex,
      environment: map.def ? map.def.environment : undefined,
      // EscapeRopeOrDig's .CheckCanDig also refuses on a zeroed dig triple.
      canEscapeRope: this.escapeRopeTarget() != null,
      playerState: this.playerState,
      // SurfFunction.TrySurf and TrySurfOW both refuse while wBikeFlags'
      // ALWAYS_ON_BIKE is set (engine/events/overworld.asm:343-345, :498-500).
      alwaysOnBike: this.alwaysOnBike(),
      strengthActive: this.strengthActive,
      // FlashFunction tests wTimeOfDayPalset, not the map header, so a
      // PALETTE_DARK map that FLASH has already lit refuses a second FLASH.
      dark: Palettes.isDarkness(map.def, this.hour(), this.flashUsed),
      // ../pokecrystal/engine/events/overworld.asm:285, called by FLASH only
      // and only after the badge gate, because it SETS the wall-opened flag.
      openAerodactylWall: () => UnownWords.aerodactylChamber(this.events, map.id),
    };
  }

  // Lua: World.lua:5803-5838 -- CutDownTreeOrGrass / DisappearWhirlpool: one
  // entry of the loaded map's block buffer is overwritten and
  // GetMovementPermissions reruns, which is why a cut tree stops blocking the
  // step immediately. The original id is kept so setMap can put it back
  // (LoadMapAttributes refills the buffer from ROM on every load). `index` is
  // the 1-based block-index key.
  replaceBlock(index: any, blockId: any): boolean {
    const map = this.map;
    if (!(map && index != null && blockId != null)) return false;
    const blocks = map.def ? map.def.blocks : undefined;
    if (!(blocks && blocks[index - 1] != null)) return false;
    const mapId = map.id;
    let edits = this.blockEdits[mapId];
    if (!edits) {
      edits = {};
      this.blockEdits[mapId] = edits;
    }
    if (edits[index] == null) edits[index] = blocks[index - 1];
    blocks[index - 1] = blockId;
    map.blocks = blocks;
    this.refreshMapImages();
    // Gen 1's four payload keys off OverworldState:replaceBlock; every Gen 2
    // block edit lands here, so bx/by are recovered from the flat index and
    // `index` is carried alongside.
    if (Runtime.wants("world.block_replaced")) {
      const zero = index - 1;
      Runtime.emit("world.block_replaced", {
        mapId, bx: mod(zero, map.width),
        by: Math.floor(zero / map.width), block: blockId, index,
      });
    }
    return true;
  }

  // Lua: World.lua:5840-5856 -- drop every cached entry of ONE map. The bake
  // caches (mapImages, animCells, bgSets) are keyed "mapId|..." and stay as
  // World.new made them, so the sweep is kept; connectionMaps holds the
  // neighbour Map objects built off def.blocks (World:connectionMap), which a
  // block edit really does invalidate.
  dropMapImages(mapId: any): void {
    if (!truthy(mapId)) return;
    const prefix = mapId + "|";
    for (const store of [this.mapImages, this.animCells, this.bgSets]) {
      if (!store) continue;
      for (const key of Object.keys(store)) {
        if (key.startsWith(prefix)) delete store[key];
      }
    }
    if (this.connectionMaps) delete this.connectionMaps[mapId];
  }

  // Lua: World.lua:5862-5887 -- eagerly free session-owned GPU caches. There
  // are no GPU objects here (safeRelease dropped); the tables are reset as the
  // Lua resets them.
  release(): void {
    if (this.mapImages) this.mapImages = {};
    if (this.scrollStrips) this.scrollStrips = {};
    this.tiltCanvas = undefined;
    if (this.grassAtlases) this.grassAtlases = {};
    if (this.atlasCache) this.atlasCache = {};
    this.animQuads = undefined;
    this.connectionMaps = undefined;
  }

  // Lua: World.lua:5889-5913 -- LoadMapAttributes' refill, for every map the
  // session has edited. Neighbour strips share the same buffer on the cart,
  // so a connection crossing reloads them too: this runs on any setMap. The
  // cached entries go with the blocks (a MAPCALLBACK_TILES map rewrites its
  // blocks on every load).
  restoreBlocks(): boolean {
    let any = false;
    for (const mapId of Object.keys(this.blockEdits)) {
      const edits = this.blockEdits[mapId];
      const def = this.maps ? this.maps[mapId] : undefined;
      const blocks = def ? def.blocks : undefined;
      if (blocks) {
        for (const key of Object.keys(edits)) {
          blocks[Number(key) - 1] = edits[key];
          any = true;
        }
        this.dropMapImages(mapId);
      }
      delete this.blockEdits[mapId];
    }
    return any;
  }

  // Lua: World.lua:5915-5945 -- engine/overworld/map_setup.asm:78. Each
  // objectSpawns[mapId][key] is an [x, y] pair (see World:moveObject).
  restoreObjectSpawns(): void {
    const spawns = this.objectSpawns;
    if (!spawns) return;
    for (const mapId of Object.keys(spawns)) {
      const byIndex = spawns[mapId];
      const def = this.maps ? this.maps[mapId] : undefined;
      const objects = def ? def.objects : undefined;
      if (objects) {
        for (const k of Object.keys(byIndex)) {
          const key = Number(k);
          const xy = byIndex[k];
          let obj: any;
          for (const row of objects) {
            if ((row.index ?? 0) === key) { obj = row; break; }
          }
          if (obj) {
            obj.x = xy[0];
            obj.y = xy[1];
          }
          const npc = this.npcPool
            ? this.npcPool[format("%s_obj_%d", mapId, key)] : undefined;
          if (npc) {
            npc.cellX = xy[0];
            npc.cellY = xy[1];
            npc.px = xy[0] * 16;
            npc.py = xy[1] * 16;
            npc.homeX = xy[0];
            npc.homeY = xy[1];
            npc.moving = false;
            npc.progress = 0;
            npc.targetX = undefined;
            npc.targetY = undefined;
          }
        }
      }
      delete spawns[mapId];
    }
  }

  // Lua: World.lua:5947-5959 -- drop the loaded map's cached entries and
  // rebuild what reads the blocks. The Lua gated on self.mapImage (a world
  // with nothing baked yet had nothing to refresh) and re-baked with
  // `self.mapImage = self:imageFor(self.map.id)`; nothing is baked here, so a
  // loaded map stands in for the gate and the re-bake is dropped (the voxel
  // renderer reads map.blocks directly).
  refreshMapImages(): boolean {
    if (!this.map) return false;
    this.dropMapImages(this.map.id);
    this.rebuildAttrGrid();
    this.rebuildNeighbors();
    return true;
  }

  // Lua: World.lua:5961-5966 -- wPlayerGender, the byte GetPlayerSprite and
  // AddMapObject both branch on (engine/overworld/overworld.asm:61-64,
  // engine/overworld/player_object.asm:32-39).
  playerGender(): any {
    const save = this.game ? this.game.save : undefined;
    return save && save.player ? save.player.gender : undefined;
  }

  // Lua: World.lua:5968-5973 -- engine/overworld/player_object.asm:29-41;
  // pokegold player_object.asm:19
  playerObjectDef(): { palette: number } | undefined {
    if (!truthy(this.isCrystal())) return undefined;
    return truthy(FieldMoves.isFemale(this.playerGender()))
      ? PLAYER_PAL_FEMALE : PLAYER_PAL_MALE;
  }

  // Lua: World.lua:5975-5979 -- the Chris/Kris sheet the player wears with no
  // state on it (data/sprites/player_sprites.asm:2, :9).
  playerSpriteName(): string {
    const name = FieldMoves.playerSprite(this.playerGender());
    return truthy(name) ? name : PLAYER_SPRITE;
  }

  // Lua: World.lua:5981-5993 -- UpdatePlayerSprite
  // (data/sprites/player_sprites.asm ChrisStateSprites): the player's sprite
  // is a pure function of wPlayerState, which is what makes getting on and
  // off a Lapras a one-byte change rather than an animation.
  applyPlayerState(state?: any): void {
    this.playerState = truthy(state) ? state : FieldMoves.PLAYER_NORMAL;
    const stateName = FieldMoves.stateSprite(this.playerState, this.playerGender());
    const name = truthy(stateName) ? stateName : PLAYER_SPRITE;
    const def = this.sprites ? this.sprites[name] : undefined;
    if (def && this.player) {
      this.player.setSprite(def);
      this.applySpritePalette(this.player);
    }
  }

  // ---- the seven effects ----------------------------------------------------

  // Lua: World.lua:5997-6006 -- Script_Cut: GetPartyNickname, UseCutText,
  // then CutDownTreeOrGrass. The block swap happens when the box closes, so
  // the tree is still standing behind the line that says it was cut.
  runCut(result: any): void {
    this.setNickname(result.mon);
    this.showText(Strings.get(result.text), () => {
      this.replaceBlock(result.blockIndex, result.replacement);
      this.playSfx(SFX.PLACE_PUZZLE_PIECE_DOWN);
    });
  }

  // Lua: World.lua:6008-6015 -- Script_UsedWhirlpool, Script_Cut with
  // DisappearWhirlpool and PlayWhirlpoolSound in place of the snip.
  runWhirlpool(result: any): void {
    this.setNickname(result.mon);
    this.showText(Strings.get(result.text), () => {
      this.playWhirlpoolSound(result.blockIndex, result.replacement);
    });
  }

  // Lua: World.lua:6017-6023 -- PlayWhirlpoolSound is WaitSFX, SFX_SURF,
  // WaitSFX, never a bare PlaySFX -- engine/events/field_moves.asm:5-10
  // (#1717). The block swap lands after it -- engine/events/overworld.asm:1157-1164
  playWhirlpoolSound(blockIndex: any, replacement: any): void {
    this.fieldMove = {
      phase: "whirlpoolsfx", waiting: true, left: 180,
      blockIndex, replacement,
    };
  }

  // Lua: World.lua:6029-6036
  runForcedMovement(): boolean {
    const p = this.player;
    if (!p || p.moving || this.moveState) return false;
    const back = FORCED_BACK[p.facing];
    if (!back) return false;
    this.beginMovement(0, Movement.forcedMovementBytes(back));
    return true;
  }

  // Lua: World.lua:6038-6049 -- Script_UseFlash: the text plays SFX.FLASH
  // from inside itself, and BlindingFlash then sets STATUSFLAGS_FLASH_F and
  // reloads the palettes. Palettes.daytimeFor already turns a flashed
  // PALETTE_DARK map into a NITE one, the cart's own .UsedFlash arm.
  runFlash(result: any): void {
    this.playSfx(SFX.FLASH);
    this.showText(Strings.get(result.text), () => {
      this.flashUsed = true;
      if (truthy(this.applyPalettes())) this.refreshMapImages();
    });
  }

  // Lua: World.lua:6051-6071 -- UsedSurfScript: the line, then wPlayerState
  // becomes the surf state, the sprite follows it, the map music restarts
  // (surfing has its own theme) and SurfStartStep walks one slow step into
  // the water. Getting ON is a scripted step, so it never rolls an encounter.
  runSurf(result: any): void {
    this.setNickname(result.mon);
    this.showText(Strings.get(result.text), () => {
      this.applyPlayerState(result.state);
      const audio = this.game && this.game.data ? this.game.data.audio : undefined;
      if (audio && truthy(audio.runtime) && this.map) {
        // SpecialMapMusic (home/audio.asm:397)
        Music.playMap(this.game.data, this.map.id, undefined,
                      FieldMoves.isSurfing(this.playerState), undefined,
                      this.mapMusicSong(this.map.id));
      }
      if (this.player && this.player.scriptStep) {
        this.player.scriptStep(this.player.facing);
      }
      this.fieldMove = { phase: "step" };
    });
  }

  // Lua: World.lua:6073-6086 -- Script_UsedStrength: SetStrengthFlag runs
  // FIRST (callasm, before the text), then "<mon> used STRENGTH!", the mon's
  // cry, `pause 3`, and "<mon> can move boulders."
  runStrength(result: any): void {
    this.strengthActive = true;
    this.strengthMon = result.mon;
    this.setNickname(result.mon);
    this.showText(Strings.get(result.text), () => {
      this.playMonCry(result.mon);
      this.fieldMove = {
        phase: "strength", timer: STRENGTH_PAUSE_FRAMES, text: result.after,
      };
    });
  }

  // Lua: World.lua:6088-6102 -- Script_UsedWaterfall: the line,
  // SFX.BUBBLEBEAM, and then a loop of one turn_waterfall UP step at a time.
  // .CheckContinueWaterfall writes wScriptVar = 0 while the player is STILL
  // on a waterfall tile and 1 once off it; `iffalse .loop` loops on 0.
  runWaterfall(result: any): void {
    this.setNickname(result.mon);
    this.showText(Strings.get(result.text), () => {
      this.playSfx(SFX.BUBBLEBEAM);
      this.fieldMove = { phase: "waterfall" };
      this.waterfallStep();
    });
  }

  // Lua: World.lua:6104-6109
  waterfallStep(): void {
    const p = this.player;
    if (!p) return;
    p.facing = "up";
    if (p.scriptStep) p.scriptStep("up");
  }

  // Lua: World.lua:6111-6119 -- callasm GetPartyNickname: {STRBUF} is the
  // nickname of the mon CheckPartyMove picked, read off game.stringBuffer.
  setNickname(mon: any): void {
    if (!this.game) return;
    const name = (mon && (mon.nickname ?? mon.name ?? mon.species)) ?? "";
    this.game.stringBuffer = name;
    // engine/events/overworld.asm:1339
    if (this.vm) this.vm.stringBuffer = name;
  }

  // Lua: World.lua:6121-6127
  playMonCry(mon: any): void {
    const data = this.game ? this.game.data : undefined;
    const cries = data && data.audio ? data.audio.cries : undefined;
    const species = mon ? mon.species : undefined;
    if (!(cries && truthy(species) && truthy(cries[species]))) return;
    this.lastSfx = Sound.playCry(data, species);
  }

  // ---- the boulder ----------------------------------------------------------

  // Lua: World.lua:6131-6134
  static isStrengthBoulder(npc: any): boolean {
    const def = npc ? npc.def : undefined;
    return def != null && def.movement === SPRITEMOVEDATA_STRENGTH_BOULDER;
  }

  // Lua: World.lua:6136-6171 -- .CheckStrengthBoulder
  // (engine/overworld/player_movement.asm), from .CheckNPC when something is
  // in the way. With BIKEFLAGS_STRENGTH_ACTIVE set and the object standing
  // still, MovementFunction_Strength steps it if CanObjectMoveInDirection
  // agrees. The player BUMPS either way: the boulder moves, the player stays.
  tryPushBoulder(dir: Facing, cx: number, cy: number): boolean {
    if (!truthy(this.strengthActive)) return false;
    const npc = this.npcAt(cx, cy);
    if (!(npc && World.isStrengthBoulder(npc)) || npc.moving) {
      return false;
    }
    const d = Map.DELTA[dir]!;
    const tx = cx + d[0], ty = cy + d[1];
    // CanObjectMoveInDirection, engine/overworld/npc_movement.asm:1
    // is MovementFunction_Strength's .ok2, engine/overworld/map_objects.asm:686
    if (!truthy(this.map.objectStepPermitted(cx, cy, dir))) return false;
    for (const e of ipairs_W4(this.entities)) {
      if (e !== npc && e.cellX === tx && e.cellY === ty) return false;
    }
    npc.scriptStep(dir);
    this.playSfx(SFX.STRENGTH);
    // Gen 1's four payload keys. Divergence, deliberate (Brian's): this fires
    // as the push is committed, and x/y are the cell the boulder steps ONTO.
    if (Runtime.wants("world.boulder_moved")) {
      Runtime.emit("world.boulder_moved", {
        mapId: this.map.id,
        npcId: ((npc.def && npc.def.index) ?? 0) + 1, x: tx, y: ty,
      });
    }
    return true;
  }

  // ---- running one --------------------------------------------------------

  // Lua: World.lua:6173-6210 -- QueueScript, as far as the port is
  // concerned: the result the model handed back is turned into the script
  // that carries it out.
  runFieldMove(result: any): boolean {
    const action = result ? result.action : undefined;
    if (action === "cut") {
      this.runCut(result);
    } else if (action === "whirlpool") {
      this.runWhirlpool(result);
    } else if (action === "flash") {
      this.runFlash(result);
    } else if (action === "surf") {
      this.runSurf(result);
    } else if (action === "strength") {
      this.runStrength(result);
    } else if (action === "waterfall") {
      this.runWaterfall(result);
    } else if (action === "fly") {
      // (engine/events/overworld.asm:565, :584); a picker that never opened
      if (truthy(result.flySpawn)) {
        this.flyTo(result.flySpawn, result.mon);
      } else {
        this.openFlyMap(result.mon);
      }
    } else if (action === "headbutt") {
      this.runHeadbutt(result.facingX, result.facingY, result.mon);
    } else if (action === "sweetscent") {
      this.runSweetScent(result);
    } else if (action === "escaperope" || action === "dig") {
      this.runDigEscape(result);
    } else if (action === "teleport") {
      this.runTeleport(result);
    } else {
      return false;
    }
    return true;
  }

  // Lua: World.lua:6212-6226 -- .UsedEscapeRopeScript / .UsedDigScript
  // (engine/events/overworld.asm EscapeRopeOrDig): the used-item line, then
  // the shared warp tail. The target was resolved when the action was
  // queued; a stale one falls back to re-resolving, and to nothing at worst.
  runDigEscape(result: any): void {
    this.setNickname(result.mon);
    this.showText(Strings.get(result.text), () => {
      let destMapId = result.destMap, destWarp = result.destWarp;
      if (!(truthy(destMapId) && truthy(destWarp))) {
        const target = this.escapeRopeTarget();
        destMapId = target != null ? target[0] : undefined;
        destWarp = target != null ? target[1] : undefined;
      }
      if (truthy(destMapId)) this.runEscapeWarp(destMapId, destWarp);
    });
  }

  // Lua: World.lua:6228-6244 -- TeleportFunction's .TeleportScript: the
  // return line, then WarpToSpawnPoint with `newloadmap MAPSETUP.TELEPORT`
  // (World:warpToSpawn). PLAYER_NORMAL first, so a teleport off a bike
  // arrives on foot -- engine/events/overworld.asm:940-955
  runTeleport(result: any): void {
    this.setNickname(result.mon);
    this.showText(Strings.get(result.text), () => {
      this.playSfxNamed("Sfx_WarpTo", SFX.WARP_TO);
      this.applyPlayerState(FieldMoves.PLAYER_NORMAL);
      this.runMapSetup(MAPSETUP.TELEPORT, () => {
        this.warpToSpawn();
        return true;
      });
    });
  }

  // Lua: World.lua:6260-6288 -- PokemonActionSubmenu's MONMENU_FIELD_MOVE
  // arm: the party list has already chosen the mon, so the badge is checked
  // with the noisy CheckBadge and the move is taken on trust. Returns the
  // result so the party menu knows whether it was refused. A success is
  // QUEUED, not run: "<mon> used CUT!" belongs over the overworld, once the
  // menus are gone. Try*OW is the other half and runs on the spot.
  useFieldMove(moveId: any, mon?: any): any {
    if (!(this.map && this.player)) return undefined;
    if (truthy(this.battleActive) || truthy(this.busy())) {
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }
    const ctx = this.fieldContext(mon);
    const result = withBlockIndex(FieldMoves.fromMenu(moveId, ctx), ctx);
    result.mon = truthy(result.mon) ? result.mon : mon;
    // ../pokecrystal/engine/pokemon/mon_menu.asm:735
    if (truthy(result.ok) && truthy(result.inMenu)) {
      return result;
    }
    if (truthy(result.ok)) {
      this.queuedFieldMove = result;
    } else if (truthy(result.text)) {
      this.showText(Strings.get(result.text));
    }
    return result;
  }

  // Lua: World.lua:6290-6296 -- the queued script, once the world owns the
  // frame again.
  runQueuedFieldMove(): boolean {
    const queued = this.queuedFieldMove;
    if (!queued || truthy(this.busy())) return false;
    this.queuedFieldMove = undefined;
    return this.runFieldMove(queued);
  }

  // Lua: World.lua:6298-6319 -- TryTileCollisionEvent's arms, each a "did
  // this take the A press" answer. A result with `ask` opens AskXScript's
  // yesorno first; one without runs (or refuses) straight away.
  runOverworldFieldMove(result: any): boolean {
    if (!result || !truthy(result.took)) return false;
    if (!truthy(result.ok)) {
      if (truthy(result.text)) this.showText(Strings.get(result.text));
      return true;
    }
    if (truthy(result.ask)) {
      this.showText(Strings.get(result.ask), () => {
        this.askYesNo((yes: any) => {
          // AskCutScript's `iffalse .declined` and friends: NO is a plain
          // closetext, and CUT's own map check only happens after the YES.
          if (truthy(yes) && truthy(result.action)) this.runFieldMove(result);
        });
      });
      return true;
    }
    this.runFieldMove(result);
    return true;
  }

  // Lua: World.lua:6321-6326
  tryCutOW(): boolean {
    const ctx = this.fieldContext();
    if (!truthy(Permissions.isCutTree(ctx.facingColl))) return false;
    return this.runOverworldFieldMove(
      withBlockIndex(FieldMoves.tryCutOW(ctx), ctx));
  }

  // Lua: World.lua:6328-6333
  tryWhirlpoolOW(): boolean {
    const ctx = this.fieldContext();
    if (!truthy(Permissions.isWhirlpool(ctx.facingColl))) return false;
    return this.runOverworldFieldMove(
      withBlockIndex(FieldMoves.tryWhirlpoolOW(ctx), ctx));
  }

  // Lua: World.lua:6335-6340
  tryWaterfallOW(): boolean {
    const ctx = this.fieldContext();
    if (!truthy(Permissions.isWaterfall(ctx.facingColl))) return false;
    return this.runOverworldFieldMove(
      withBlockIndex(FieldMoves.tryWaterfallOW(ctx), ctx));
  }

  // Lua: World.lua:6342-6349 -- TrySurfOW is the last arm and the only one
  // with no tile test of its own: it fails silently unless the facing tile
  // really is water.
  trySurfOW(): boolean {
    const ctx = this.fieldContext();
    return this.runOverworldFieldMove(
      withBlockIndex(FieldMoves.trySurfOW(ctx), ctx));
  }

  // Lua: World.lua:6351-6359 -- AskStrengthScript, which a boulder's own
  // script jumps to (jumpstd StrengthBoulderScript): reached by talking to a
  // boulder; walking into one is the push.
  tryStrengthOW(): boolean {
    const ctx = this.fieldContext();
    return this.runOverworldFieldMove(
      withBlockIndex(FieldMoves.tryStrengthOW(ctx), ctx));
  }

  // ---- fly ------------------------------------------------------------------

  // Lua: World.lua:6367-6372
  landmarkIndex(id: string, fallback?: number): number | undefined {
    const records = this.landmarks ? this.landmarks.landmarks : undefined;
    const record = records ? (records["LANDMARK_" + id] ?? records[id]) : undefined;
    const index = record ? tonumber(record.index) : undefined;
    return index ?? fallback;
  }

  // Lua: World.lua:6374-6393 -- IsInJohto, the PLAYER's landmark and nothing
  // else (home/region.asm:1). "johto" | "kanto".
  region(): "johto" | "kanto" {
    const landmarks = this.landmarks ? this.landmarks.landmarks : undefined;
    const id = this.map && this.map.def ? this.map.def.landmark : undefined;
    let entry: any;
    if (typeof id === "string") {
      entry = landmarks ? landmarks[id] : undefined;
    } else if (typeof id === "number") {
      const order = this.landmarks ? this.landmarks.order : undefined;
      // Lua order[id + 1]: landmarks.order is a 0-based JSON array
      entry = order && landmarks ? landmarks[order[id]] : undefined;
    }
    const index: number = (entry && entry.index != null) ? entry.index
      : (typeof id === "number" ? id : 0);
    // ../pokecrystal/home/region.asm:10 (cp LANDMARK_FAST_SHIP)
    if (index === this.landmarkIndex("FAST_SHIP", LANDMARK_FAST_SHIP)) {
      return "johto";
    }
    // ../pokecrystal/home/region.asm:23 (cp KANTO_LANDMARK)
    return index >= this.landmarkIndex("PALLET_TOWN", LANDMARK_PALLET_TOWN)!
      ? "kanto" : "johto";
  }

  // Lua: World.lua:6395-6398
  flyPoints(): any[] {
    return FieldMoves.flyPoints(
      this.game ? this.game.save : undefined, this.landmarks, this.region());
  }

  // Lua: World.lua:6419-6422 -- engine/sprite_anims/core.asm:216
  // (UpdateAnimFrame). A leaf's 160x144 screen position, as a TUPLE [x, y]
  // (the Lua's two returns).
  static leafScreenPos(leaf: FlyLeaf): [number, number] {
    return [leaf.x + (leaf.xoff ?? 0) + FLY.LEAF_OX, leaf.y + FLY.LEAF_OY];
  }

  // Lua: World.lua:6424-6427 -- engine/sprite_anims/core.asm:216
  // (UpdateAnimFrame). The bird's screen position, a TUPLE [x, y].
  static birdScreenPos(fa: FlyAnimState): [number, number] {
    return [FLY.BIRD_OX + (fa.xoff ?? 0), FLY.BIRD_OY + (fa.y ?? 0)];
  }

  // Lua: World.lua:6429-6432 -- engine/sprite_anims/core.asm:229 (UpdateAnimFrame)
  static offGbScreen(x: number, y: number, w: number, h: number): boolean {
    return x + w <= 0 || y + h <= 0 || x >= 160 || y >= 144;
  }

  // Lua: World.lua:6434-6459 -- FlyFunction_InitGFX's GetSpeciesIcon
  // (engine/events/field_moves.asm:390): the icon of the mon in
  // wCurPartyMon, on PAL_OW_RED like every other OW OBJ. The Lua built a
  // SpriteRenderer; this keeps a SpriteHandle over the same def (its `image`
  // is the icon's gfx key) with the OBJ palette set on it.
  flyIconFor(mon: any): SpriteHandle | undefined {
    if (mon === null || typeof mon !== "object") return undefined;
    const data = this.game ? this.game.data : undefined;
    const icons = data ? data.gen2Icons : undefined;
    const iconId = truthy(mon.isEgg) ? "ICON_EGG"
      : (icons && icons.species && truthy(mon.species)
        ? icons.species[mon.species] : undefined);
    const entry = truthy(iconId) && icons && icons.icons ? icons.icons[iconId] : undefined;
    if (!(entry && truthy(entry.image))) return undefined;
    const def = {
      id: "SPRITE_FLY_MON", image: entry.image, frames: 2, walker: false,
      spriteType: "POKEMON_SPRITE", palette: "PAL_OW_RED", paletteId: 0,
      species: mon.species, icon: iconId,
    };
    let icon: SpriteHandle | undefined;
    try {
      icon = SpriteHandle.new(def, "gen2fly");
    } catch {
      return undefined;
    }
    const daytime = this.daytime ?? Palettes.daytimeFor(
      this.map ? this.map.def : undefined, this.hour(), this.flashUsed);
    const colors = Palettes.spritePalette(this.palettes, daytime, def);
    if (truthy(colors)) {
      icon.setObjPalette(colors, format("gen2:%s:0", tostring(daytime)));
    }
    return icon;
  }

  // Lua: World.lua:6461-6479 -- false when there is no icon sheet: the caller
  // then flies without parking the world on an animation.
  startFlyAnim(phase: "from" | "to", mon: any, onDone?: () => any): boolean {
    const icon = this.flyIconFor(mon);
    const p = this.player;
    if (!(icon && p)) return false;
    const landing = phase === "to";
    this.flyAnim = {
      phase, icon, onDone, t: 0,
      xoff: 0, wave: 0,
      leaves: [],
      left: landing ? FLY.TO_FRAMES : FLY.FROM_FRAMES,
      hover: landing ? 0 : FLY.HOVER,
      amp: landing ? FLY.TO_AMP : 0,
      y: landing ? -FLY.TO_RISE : 0,
      preroll: landing ? 0 : FLY.FROM_PREROLL,
    } as FlyAnimState;
    return true;
  }

  // Lua: World.lua:6481-6519 -- FlyFunction_FrameTimer
  // (engine/events/field_moves.asm:409) over the two AnimSeq_Fly* curves;
  // the wobble is Sprites_Cosine's d * cos(n * pi / 32).
  stepFlyAnim(): void {
    const fa: FlyAnimState | undefined = this.flyAnim;
    if (!fa) return;
    if ((fa.preroll ?? 0) > 0) {
      fa.preroll = fa.preroll - 1;
      return;
    }
    const left = fa.left;
    if (left <= 0) {
      const done = fa.onDone;
      this.flyAnim = undefined;
      if (done) done();
      return;
    }
    this.spawnFlyLeaves(fa);
    fa.left = left - 1;
    if (left >= 0x40 && mod(left, 8) === 0) {
      this.playSfxNamed("Sfx_Fly", SFX.FLY);
    }
    fa.t = fa.t + 1;
    const amp = fa.amp;
    if (fa.phase === "to") {
      if (fa.y >= 0) return;
      fa.y = fa.y + 2;
      if (amp > 0) fa.amp = amp - 2;
    } else {
      if (fa.hover > 0) {
        fa.hover = fa.hover - 1;
        return;
      }
      if (fa.y <= -FLY.RISE) return;
      fa.y = fa.y - 2;
      if (amp < FLY.AMP_MAX) fa.amp = amp + 8;
    }
    fa.xoff = Math.floor(amp * Math.cos(mod(fa.wave, 64) * Math.PI / 32));
    fa.wave = fa.wave + 1;
  }

  // Lua: World.lua:6521-6547 -- engine/events/field_moves.asm:429-446,
  // engine/sprite_anims/functions.asm:1389-1416
  spawnFlyLeaves(fa: FlyAnimState): void {
    let leaves = fa.leaves;
    if (!leaves) {
      leaves = [];
      fa.leaves = leaves;
    }
    const counter = this.flyLeafCounter ?? 0;
    this.flyLeafCounter = mod(counter + 1, 256);
    if (mod(counter, 8) === 0 && leaves.length < FLY.LEAF_MAX) {
      const row = mod(Math.floor(this.flyLeafCounter / 8), 4);
      leaves.push({ x: 0, y: row * 16 + 0x40, wave: 0, xoff: 0 });
    }
    for (let i = leaves.length - 1; i >= 0; i--) {
      const leaf = leaves[i]!;
      if (leaf.x >= FLY.LEAF_DEATH_X) {
        leaves.splice(i, 1);
      } else {
        leaf.x = leaf.x + 2;
        leaf.y = leaf.y - 1;
        leaf.xoff = Math.floor(FLY.LEAF_AMP
          * Math.cos(mod(leaf.wave, 64) * Math.PI / 32));
        leaf.wave = leaf.wave + 1;
      }
    }
  }

  // Lua: World.lua:6549-6553 -- engine/events/overworld.asm:597;
  // engine/overworld/warp_connection.asm:315-331. A TUPLE [hideAll,
  // hidePlayer] (the Lua's two returns; always equal).
  flyHides(): [boolean, boolean] {
    const all = this.flyAnim != null || this.flyHidden != null;
    return [all, all];
  }

  // Lua: World.lua:6555-6559 -- engine/events/field_moves.asm:429-446. Where
  // the 160x144 GB screen sits in the view, a TUPLE [x, y] (the Lua's two
  // returns; BattleTransition reads it too). Zoom is inert, so [0, 0].
  gbScreenOrigin(): [number, number] {
    return [Math.floor(((this.viewW ?? 160) - 160) / 2),
      Math.floor(((this.viewH ?? 144) - 144) / 2)];
  }

  // Lua: World.lua:6561-6595 drawFlyLeaves: drawing, replaced by viewState()
  // Lua: World.lua:6597-6623 drawFlyAnim: drawing, replaced by viewState()

  // Lua: World.lua:6625-6653 -- .FlyScript: FlyFromAnim, WarpToSpawnPoint,
  // `newloadmap MAPSETUP_TELEPORT`, then FlyToAnim --
  // engine/events/overworld.asm:595-609
  flyTo(spawnId: any, mon?: any): any {
    const spawn = this.landmarks && this.landmarks.spawns
      ? this.landmarks.spawns[spawnId] : undefined;
    if (!(spawn && truthy(spawn.map) && this.maps && this.maps[spawn.map])) {
      if (this.flyHidden === "from") this.flyHidden = undefined;
      return false;
    }
    const warp = (): any => {
      this.applyPlayerState(FieldMoves.PLAYER_NORMAL);
      const ok = this.runMapSetup(MAPSETUP.TELEPORT, () => {
        // data/maps/setup_scripts.asm:26
        // engine/overworld/map_setup.asm:93
        this.flyHidden = "to";
        return this.setMap(spawn.map, spawn.x, spawn.y, "down");
      }, true);
      if (this.mapSetup) {
        this.mapSetup.flyIn = mon;
      } else {
        this.flyHidden = undefined;
      }
      return ok;
    };
    // engine/events/overworld.asm:597
    this.flyHidden = "from";
    if (this.startFlyAnim("from", mon, warp)) return true;
    return warp();
  }

  // Lua: World.lua:6655-6718 -- _FlyMap: the town map with the cursor locked
  // to visited flypoints, A takes the one under it and B leaves. The screen
  // is Pokegear's fly mode (Pokegear.FLY_MAP). With no screen stack (a
  // headless probe) the destinations are offered one at a time through the
  // yesorno box. engine/events/overworld.asm:556, :578 over
  // engine/pokemon/mon_menu.asm:624. The Lua's pcall(require Pokegear) is the
  // header's import (always "ok").
  openFlyMap(mon?: any, opts?: any): boolean {
    const points = this.flyPoints();
    if (points.length === 0) return false;
    if (truthy(Pokegear.FLY_MAP) && this.game && this.game.stack) {
      const pushGear = (): void => {
        Screens.push(this.game, "Gen2Pokegear", {
          save: this.game.save,
          currentLandmark: this.currentLandmarkId(),
          fly: points,
          // (../pokecrystal/engine/pokegear/pokegear.asm:2708-2721).
          flyMon: mon,
          onFly: (spawnId: any) => {
            this.game.stack.pop();
            if (opts && opts.onChosen) {
              opts.onChosen(spawnId);
            } else {
              this.flyTo(spawnId, mon);
            }
          },
          onClose: () => {
            this.game.stack.pop();
            if (opts) {
              // engine/pokegear/pokegear.asm:2062-2078, engine/menus/start_menu.asm:503-518
              const party = this.game.save ? this.game.save.party : undefined;
              Screens.push(this.game, "Gen2BlankScreen", {
                frames: World.flyCancelBlankFrames(party ? party.length : 0),
                onDone: () => { this.game.stack.pop(); },
              });
            }
            if (opts && opts.onCancel) opts.onCancel();
          },
        });
      };
      if (opts) {
        // engine/pokegear/pokegear.asm:2027-2046
        Screens.push(this.game, "Gen2BlankScreen", {
          frames: FLY_MAP_BUILD_FRAMES,
          onDone: () => {
            this.game.stack.pop();
            pushGear();
          },
        });
      } else {
        pushGear();
      }
      return true;
    }
    if (opts) return false;
    this.askFlyPoint(points, 1, mon);
    return true;
  }

  // Lua: World.lua:6720-6733 -- `index` is the Lua's 1-based position in
  // `points` (openFlyMap starts it at 1).
  askFlyPoint(points: any[], index: number, mon?: any): void {
    const row = points[index - 1];
    if (!row) return;
    const name = String(truthy(row.name) ? row.name : row.landmark).replace(/\n/g, " ");
    this.showText(Strings.get(FieldMoves.TEXT.ASK_FLY_TO, name), () => {
      this.askYesNo((yes: any) => {
        if (truthy(yes)) {
          this.flyTo(row.spawn, mon);
        } else {
          this.askFlyPoint(points, index + 1, mon);
        }
      });
    });
  }

  // Lua: World.lua:6735-6741
  currentLandmarkId(): string | undefined {
    const def = this.map ? this.map.def : undefined;
    const id = def ? def.landmark : undefined;
    if (typeof id === "string") return id;
    const order = this.landmarks ? this.landmarks.order : undefined;
    // Lua order[id + 1]: landmarks.order is a 0-based JSON array
    return order && id != null ? (order[id] ?? undefined) : undefined;
  }

  // ---- the per-frame half ---------------------------------------------------

  // Lua: World.lua:6743-6786 -- the tail of the scripts above: a `pause`,
  // the surf step landing, and the waterfall climb's loop. On the cart these
  // are script commands, so the world is frozen for them.
  updateFieldMove(): void {
    const st = this.fieldMove;
    if (!st) return;
    if (this.textbox || this.choicebox) return;
    if (st.timer != null && st.timer > 0) {
      st.timer = st.timer - 1;
      return;
    }
    if (st.phase === "whirlpoolsfx") {
      st.left = (st.left ?? 0) - 1;
      if (st.waiting) {
        if (truthy(Sound.sfxBusy()) && st.left > 0) return;
        st.waiting = undefined;
        this.playSfxNamed("Sfx_Surf", SFX.SURF);
        return;
      }
      if (truthy(Sound.sfxBusy()) && st.left > 0) return;
      this.fieldMove = undefined;
      // engine/events/overworld.asm:1163-1164
      if (st.blockIndex != null) this.replaceBlock(st.blockIndex, st.replacement);
      return;
    }
    if (st.phase === "strength") {
      this.fieldMove = undefined;
      if (truthy(st.text)) this.showText(Strings.get(st.text));
      return;
    }
    if (this.player && this.player.moving) return;
    if (st.phase === "waterfall") {
      // Still on a waterfall tile: another turn_waterfall UP.
      const coll = this.map.cellCollision(this.player.cellX, this.player.cellY);
      if (truthy(FieldMoves.waterfallContinues(coll))) {
        this.waterfallStep();
        return;
      }
    }
    this.fieldMove = undefined;
  }

  // Lua: World.lua:6788-6814 -- which song this battle fights to
  // (engine/battle/start_battle.asm PlayBattleMusic), and the facts
  // BattleMusic needs to pick it: the opponent's class, the member inside it
  // (only RIVAL2 reads that), the map's landmark for RegionCheck, the clock.
  battleMusicContext(opts?: any): any {
    const members = this.constants ? this.constants.trainerClassMembers : undefined;
    const trainer = opts ? opts.trainer : undefined;
    const save = this.game ? this.game.save : undefined;
    let battleType: any = opts ? opts.battleType : undefined;
    if (!truthy(battleType)) {
      battleType = opts && truthy(opts.roaming) ? BATTLETYPE.ROAMING : undefined;
    }
    return {
      battleTheme: this.modBattleTheme(opts),
      class: trainer ? trainer.classId : undefined,
      member: trainer ? trainer.memberId : undefined,
      members: trainer && truthy(trainer.classId) && members
        ? (members[trainer.classId] ?? undefined) : undefined,
      landmark: this.map && this.map.def ? this.map.def.landmark : undefined,
      // PlayBattleMusic reads wTimeOfDay (engine/battle/start_battle.asm:24),
      // not the map's pinned palette set.
      daytime: this.tod,
      // ../pokecrystal/engine/battle/start_battle.asm:60-66
      // wBattleType write at ../pokecrystal/engine/overworld/wildmons.asm:561
      battleType,
      crystal: GameVersion.engine((save && save.version)
        || GameVersion.get()) === "crystal",
    };
  }

  // Lua: World.lua:6816-6834 -- a mod-set battle theme: the class'
  // trainers.battleTheme, else the wild species' pokemon.battleTheme;
  // undefined for vanilla content.
  modBattleTheme(opts?: any): any {
    const data = this.game ? this.game.data : undefined;
    if (!data) return undefined;
    const trainer = opts ? opts.trainer : undefined;
    if (trainer) {
      // classId keys data.trainers.classes; classIndex is keyed by the
      // numeric `class`
      const classes = data.trainers ? data.trainers.classes : undefined;
      let entry = truthy(trainer.classId) && classes ? classes[trainer.classId] : undefined;
      if (!truthy(entry)) {
        entry = truthy(trainer.class) ? Trainers.classIndex(data.trainers)[trainer.class] : undefined;
      }
      return entry ? (entry.battleTheme ?? undefined) : undefined;
    }
    const wild = opts ? opts.wild : undefined;
    const def = wild && truthy(wild.species) && data.pokemon
      ? data.pokemon[wild.species] : undefined;
    return def ? (def.battleTheme ?? undefined) : undefined;
  }

  // Lua: World.lua:6836-6844
  playBattleMusic(opts?: any): any {
    const data = this.game ? this.game.data : undefined;
    const audio = data ? data.audio : undefined;
    if (!(audio && audio.songs)) return undefined;
    const song = BattleMusic.battleSong(this.battleMusicContext(opts));
    if (!(truthy(song) && truthy(audio.songs[song]))) return undefined;
    Music.play(data, song, true, { reason: "battle" });
    return song;
  }

  // Lua: World.lua:6846-6854 -- ../pokecrystal/engine/battle/start_battle.asm:15
  static transitionStatusByte(status: any, turns?: number): number {
    if (status === "sleep") return Math.min(turns ?? 1, 7);
    if (status === "poison" || status === "toxic") return 8;
    if (status === "burn") return 16;
    if (status === "freeze") return 32;
    if (status === "paralyze") return 64;
    return 0;
  }

  // Lua: World.lua:6856-6868 -- ../pokecrystal/engine/battle/start_battle.asm:15-35
  transitionBattleMonLevel(): number {
    const save = this.game ? this.game.save : undefined;
    const engine = GameVersion.engine((save && save.version) || GameVersion.get());
    if (engine !== "crystal") return this.staleBattleMonLevel ?? 0;
    for (const mon of (save && save.party) || []) {
      if ((mon.hp ?? 0) > 0) {
        return World.transitionStatusByte(mon.status, mon.statusTurns);
      }
    }
    return 0;
  }

  // Lua: World.lua:6870-6878 -- ../pokegold/engine/battle/core.asm:5995
  recordStaleBattleLevels(battle: any): void {
    if (battle.enemy && battle.enemy.level != null) {
      this.staleEnemyMonLevel = battle.enemy.level;
    }
    if (battle.player && battle.player.level != null) {
      this.staleBattleMonLevel = battle.player.level;
    }
  }

  // Lua: World.lua:6880-6897 -- DoBattleTransition. True when the wipe took
  // the screen, false when there is nothing to wipe (no stack, or no map up)
  // and the battle should just come straight in.
  // ../pokegold/engine/battle/core.asm:7782-7783
  // ../pokegold/engine/battle/battle_transition.asm:164
  pushBattleTransition(battle: any, opts?: any, onDone?: any): boolean {
    const game = this.game;
    if (!(game && game.stack && this.map)) return false;
    Screens.push(game, "Gen2BattleTransition", {
      world: this,
      trainer: truthy(opts && opts.trainer),
      environment: this.map.def ? this.map.def.environment : undefined,
      playerLevel: this.transitionBattleMonLevel(),
      enemyLevel: this.staleEnemyMonLevel ?? 0,
      onDone,
    });
    return true;
  }
  // ---- W5: World.lua:6900-8683 ---------------------------------------------

  // Lua: World.lua:6899-6902 -- ../pokecrystal/engine/overworld/events.asm:284-285
  cancelMapNameSign(): void {
    MapNameSign.cancel(this);
  }

  // Lua: World.lua:6904-7087
  // Push the battle screen. Kept here rather than in Game2 so a trainer
  // script and a grass step start a battle the same way.
  //
  // The order is the cart's: DoBattleTransition owns the screen first, and
  // only when it has finished blacking the overworld out does the battle
  // screen come up. PlayBattleMusic runs BEFORE the transition, which is why
  // the battle theme is already going while the wipe is still spinning.
  startBattle(opts: any, onDone?: (outcome?: any) => void): boolean {
    const game = this.game;
    if (!(game && game.stack)) {
      if (onDone) onDone("win");
      return false;
    }
    this.cancelMapNameSign();
    const battle = Battle.new({
      data: game.data,
      // BATTLETYPE_TUTORIAL fights with an EMPTY party: engine/battle/core.asm
      // jumps straight to BattleMenu without a send-out, so the DUDE's demo
      // has no player mon at all and the caller passes its own party in.
      party: truthy(opts.party) ? opts.party
        : (game.save && truthy(game.save.party) ? game.save.party : []),
      wild: opts.wild,
      trainer: opts.trainer,
      // wMoney and wMomsMoney, for WinTrainerBattle's payout
      // (battle/Prize.ts). The battle writes both accounts itself, the way
      // the cart's own trainer-defeated arm does, so a fight that never comes
      // back through the script still pays.
      save: game.save,
      // BATTLETYPE_ROAMING: the save slot whose HP byte the end of the battle
      // writes back. Only World:tryWildEncounter sets it.
      roaming: opts.roaming,
      // wBattleType, when the script armed one: the FORCESHINY / TRAP
      // no-escape rules live in Battle:tryRun and the force-switch handler.
      battleType: opts.battleType,
      // wInBattleTowerBattle (../pokecrystal/engine/events/battle_tower/
      // battle_tower.asm:220-223), which turns DoBadgeTypeBoosts off.
      battleTower: opts.battleTower,
      // wTimeOfDay, for BattleCommand_TimeBasedHealContinue
      // (engine/battle/effect_commands.asm:6401-6404).
      timeOfDay: this.timeOfDayId(),
    }) as any;
    this.playBattleMusic(opts);
    const pushBattle = (): void => {
      // wBattleMode, as far as the overworld is concerned: a battle screen
      // this world pushed is up. The PACK opened from inside one must not take
      // the field path, because a rod is ITEMMENU_NOUSE in battle
      // (data/items/attributes.asm) and the field path would fish from under it.
      this.battleActive = true;
      Screens.push(game, "Gen2BattleState", {
        battle,
        save: game.save,
        music: this.battleMusicContext(opts),
        // BATTLETYPE_CONTEST: the park ball menu, the held catch and the draw
        // on the last ball. Only World:tryContestEncounter sets it.
        contest: opts.contest,
        // BATTLETYPE_TUTORIAL: the DUDE's back-pic, no player HUD, the forced
        // POKE BALL and the throw that cannot fail. Only
        // World:startCatchTutorial sets it.
        tutorial: opts.tutorial,
        onDone: (outcome: any) => {
          this.recordStaleBattleLevels(battle);
          // WildBattleScript's reloadmapafterbattle (engine/overworld/events.asm:1158-1162)
          this.wildCooldown = 5;
          delete this.battleActive;
          game.stack.pop();
          // engine/overworld/scripting.asm:1178-1184, engine/events/whiteout.asm:1-21
          const whiteout = outcome === "lose"
            && opts.battleType !== BATTLETYPE.CANLOSE;
          // engine/overworld/events.asm:1158-1162, data/maps/setup_scripts.asm:124
          if (!whiteout && !truthy(this.scriptRunning())) {
            this.battleReturnFade();
          }
          // wBattleResult (constants/battle_constants.asm): WIN 0, LOSE 1,
          // DRAW 2. The port never forfeits or draws a battle, so "lose" is the
          // only other outcome; VAR.BATTLERESULT reads this back masked with
          // ~BATTLERESULT_BITMASK, same as the cart.
          this.lastBattleResult = (outcome === "lose") ? 1 : 0;
          // BattleEnd_HandleRoamMons, which runs on the way out of EVERY wild
          // battle: this one banks the beast's HP and moves it, and any other
          // wild battle takes the 1-in-16 `.not_roaming` roll that moves them
          // anyway. Before the loss warp, because the walk is computed against
          // the map the player is standing on.
          if (truthy(battle.wild)) {
            this.roamMonsAfterBattle(battle.roaming, outcome,
              battle.enemy ? battle.enemy.hp : undefined);
            // Script_reloadmapafterbattle's `.was_wild` arm: `bit
            // BATTLERESULT_BOX_FULL, a / jr z, .done`, then a LoadMemScript of
            // Script_SpecialBillCall (engine/overworld/scripting.asm:1097-1104)
            // -- LoadCallerScript with e = PHONE_BILL falling into
            // Script_ReceivePhoneCall (engine/phone/phone.asm:441-446).
            // BattleState sets boxFilled exactly where .SendToPC sets the bit.
            //
            // NOT one of the SPECIALCALL_* rows, so Phone.queueSpecialCall is
            // the wrong door: this is a received call wearing Bill's own
            // contact and his CALLER script. LoadMemScript is a deferral,
            // which is what World:queuedScript is here: the ring lands on the
            // first overworld frame after the reload. No `pause 30`, unlike
            // the special-call wrappers.
            if (truthy(battle.boxFilled)) {
              const call = Phone.loadCallerScript(
                Phone.PHONECONTACT_BILL, "incoming", "caller");
              if (this.vm && truthy(call.scriptKey)
                  && truthy(this.vm.scripts[call.scriptKey!])) {
                this.vm.curPhoneCaller = call.contact;
                const [name, className] = Phone.contactName(call.contact,
                  game.data ? game.data.trainers : undefined);
                this.queuedScript = PhoneRing.script(call, name, className);
              }
            }
          }
          // A loss warps home with a healed party, the way a whiteout does --
          // because it IS one: Script_reloadmapafterbattle's `cp LOSE` jumps
          // into Script_BattleWhiteout (engine/events/whiteout.asm). So the
          // losing half of the wallet goes here too, in the cart's order:
          // HealParty, then HalveMoney, then GetWhiteoutSpawn, then the warp.
          // The Bug Contest is the one exception the script itself carries
          // (`checkflag ENGINE_BUG_CONTEST_TIMER / iftrue .bug_contest` skips
          // both callasms), so a wipe in the park costs nothing.
          //
          // BATTLETYPE.CANLOSE is the other exception, and it is the battle
          // engine's own: LostBattle prints the loss text for this type and
          // returns with the player exactly where they fought, and
          // maps/CherrygroveCity.asm follows the battle with `reloadmap` and
          // its .AfterYourDefeat arm; `special HealParty` at .FinishRival is
          // what heals the party, not a whiteout.
          if (whiteout) {
            this.healParty();
            if (!truthy(BugContest.isActive(game.save))) {
              CallAsm.run(this, "HalveMoney");
              CallAsm.run(this, "GetWhiteoutSpawn");
            }
            // The second of the two blackout seams, same as Gen 1's pair (the
            // poison walk in World:whiteOut is the other).
            if (Runtime.wants("world.blacked_out")) {
              Runtime.emit("world.blacked_out",
                { save: game.save, healTarget: this.healPoint() });
            }
            // engine/events/whiteout.asm:19-20
            this.runMapSetup(MAPSETUP.WARP, () => {
              this.warpToSpawn();
              return true;
            });
          }
          // RestartMapMusic: the map theme comes back with the overworld, over
          // whatever the battle left playing (the victory jingle loops until
          // exactly here). Unconditional, because the one-shot
          // wDontPlayMapMusicOnReload the Sudowoodo and Snorlax battles set is
          // not consumed here at all: `dontrestartmapmusic` is the command
          // AFTER `startbattle` (maps/CherrygroveCity.asm:124-126), and it is
          // the `reloadmap` behind it that owns the silence
          // (World:forceMapMusic). A wild encounter has no reload behind it
          // and still needs this restore.
          this.restoreMapMusic();
          // BugCatchingContestBattleScript's own tail, which runs after
          // `reloadmapafterbattle`: out of park balls sends the player back to
          // the gate rather than back into the grass.
          if (truthy(opts.contest) && truthy(this.bugContestBattleOver())) return;
          // Script_reloadmapafterbattle's .notblackedout arm: `bit
          // BATTLESCRIPT_WILD_F, d` is SET for a trainer (the flag's name
          // reads backwards), so it is a won TRAINER battle and nothing else
          // that gives Mom a chance to spend the savings.
          if (truthy(opts.trainer) && outcome !== "lose") this.momTriesToBuy();
          // A scripted battle resumes the VM here; the trainer flag and the
          // after-battle text are the commands waiting on the other side.
          if (onDone) onDone(outcome);
        },
      });
    };
    const transition = this.pushBattleTransition(battle, opts, pushBattle);
    if (!truthy(transition)) pushBattle();
    return true;
  }

  // Lua: World.lua:7089-7105 -- wWinTextPointer / wLossTextPointer
  // (home/trainers.asm:120), overwritten by `winlosstext`
  // (engine/overworld/scripting.asm:651). Returns the TUPLE [winText,
  // lossText] (Lua's two results); only startScriptedBattle reads it.
  trainerWinLossText(): [any, any] {
    const vm = this.vm;
    if (!vm) return [undefined, undefined];
    const obj = vm.trainerObject ?? {};
    const text = this.text ?? {};
    // `winlosstext` writes BOTH pointers; a 0 argument destroys the struct
    // value rather than falling back to it.
    let winKey: any, lossKey: any;
    if (truthy(vm.winLossArmed)) {
      winKey = vm.winTextOverride;
      lossKey = vm.lossTextOverride;
    } else {
      winKey = obj.winText;
      lossKey = obj.lossText;
    }
    return [truthy(winKey) ? (text[winKey] ?? undefined) : undefined,
            truthy(lossKey) ? (text[lossKey] ?? undefined) : undefined];
  }

  // Lua: World.lua:7107-7213
  // `startbattle` from a script: a trainer record (class + member) or a
  // loadwildmon pair. The VM is parked on the yield until onDone fires, so
  // the rest of the trainer script (flag set, after-battle text) runs on return.
  startScriptedBattle(record: any, wild: any, onDone?: (outcome?: any) => void): boolean {
    const data = this.game ? this.game.data : undefined;
    const opts: Record<string, any> = {};
    if (truthy(record)) {
      // The battle screen names a trainer the way the cart does: class then
      // name, "YOUNGSTER JOEY".
      let display = record.name;
      if (truthy(record.className) && record.className !== "") {
        display = record.className + " " + (record.name ?? "");
      }
      let bareName = record.name;
      // PlaceEnemysName (home/text.asm:327), what <ENEMY> resolves to: with
      // wTrainerClass RIVAL1 or RIVAL2 it prints wRivalName ALONE, because
      // every rival row in data/trainers/parties.asm carries `db "?@"`.
      // wRivalName is what `special NameRival` (maps/ElmsLab.asm:515) wrote;
      // before that it still holds InitializeNPCNames' "???", which is the
      // name the Cherrygrove theft battle prints -- so "???" is the fallback,
      // NOT NameRival's own SILVER default. record.className is left alone:
      // it is the class key Palettes.trainerColors and BattleMusic read.
      if (record.classId === "RIVAL1" || record.classId === "RIVAL2") {
        const save = this.game ? this.game.save : undefined;
        display = (save && save.rival && truthy(save.rival.name)) ? save.rival.name : "???";
        bareName = display;
      }
      opts.trainer = {
        class: record.class,
        // The class and member CONSTANTS (RIVAL2, RIVAL2_2_CHIKORITA), which
        // is what PlayBattleMusic's ladder compares against.
        classId: record.classId,
        memberId: record.id,
        name: display,
        trainerName: bareName,
        className: record.className,
        party: Trainers.party(data, record),
        // TRNATTR_BASE_REWARD, the third byte of the class's seven-byte
        // attributes row. ComputeTrainerReward multiplies it by the LAST
        // party row's level, so the party and this byte travel together.
        baseMoney: record.baseMoney,
        // The rest of the class's attributes row (data/trainers/attributes.asm):
        // the AI personality bytes and the two TRNATTR_ITEM slots AI_TryItem
        // may reach for. Trainers.lookup builds `items` as a fresh copy so a
        // battle using one up does not empty the class record.
        attributes: record.attributes,
        items: record.items,
      };
      // wWinTextPointer / wLossTextPointer, read by PrintWinLossText on the
      // battle screen (home/trainers.asm:230) (#1512)
      [opts.trainer.winText, opts.trainer.lossText] = this.trainerWinLossText();
    } else if (truthy(wild) && truthy(wild.species)) {
      const [id, def] = speciesByIndex(data ? data.pokemon : undefined, wild.species);
      // InitEnemyMon `.NotRoaming` / BATTLETYPE.FORCESHINY: the DV pair is
      // forced to ATKDEFDV_SHINY $EA / SPDSPCDV_SHINY $AA (Attack 14, the rest
      // 10) before stats are built -- the whole of what makes the Red Gyarados
      // red, and caught, it keeps the DVs and stays shiny.
      let monOpts: any;
      if (this.battleType() === BATTLETYPE.FORCESHINY) {
        monOpts = { dvs: { attack: 14, defense: 10, speed: 10, special: 10 } };
      }
      opts.wild = id ? Mon.new(data, id, wild.level ?? 5, monOpts) : undefined;
      // InitEnemyMon's `.WildItem` / BATTLETYPE.FORCEITEM: Item1 is handed
      // over unconditionally, no roll. Read here rather than after
      // startBattle, because scriptVars[VAR.BATTLETYPE] is cleared the moment
      // this function hands off to it.
      if (truthy(opts.wild) && this.battleType() === BATTLETYPE.FORCEITEM) {
        const given = def && def.items ? def.items[0] : undefined;
        if (truthy(given)) opts.wild.item = given;
      }
    }
    // engine/overworld/scripting.asm Script_startbattle
    if (!(truthy(opts.trainer) && opts.trainer.party.length > 0) && !truthy(opts.wild)) {
      Logger.warn(
        "no battle opened (trainer %s, class %s, member %s, party %d, wild %s)",
        tostring(record ? record.name : undefined), tostring(record ? record.class : undefined),
        tostring(record ? record.member : undefined),
        truthy(opts.trainer) ? opts.trainer.party.length : 0,
        tostring(wild ? wild.species : undefined));
      if (!truthy(wild)) {
        this.refuseTrainer(truthy(record) ? record : (this.vm ? this.vm.trainerObject : undefined));
      }
      if (onDone) onDone(undefined);
      return false;
    }
    // wBattleType, which `writevar VAR.BATTLETYPE / loadvar BATTLETYPE_*`
    // armed: FORCEITEM 10 (Lugia, Ho-Oh, the Red Gyarados), FORCESHINY 7,
    // TRAP 9 (the Rocket base), CANLOSE 1 (the Cherrygrove rival). A ONE-SHOT
    // on the cart -- BattleStart_TrainerBattle / StartWildBattle reset it --
    // so the value is taken and cleared here and handed to the battle.
    opts.battleType = this.battleType();
    delete this.scriptVars[VAR.BATTLETYPE];
    return this.startBattle(opts, onDone);
  }

  // Lua: World.lua:7215-7251
  // `catchtutorial BATTLETYPE_TUTORIAL`: CatchTutorial (engine/events/
  // catch_tutorial.asm) around a real battle. The name swap, the DUDE's pack
  // and the option override live in core/CatchTutorial.ts; the battle itself
  // is the ordinary wild path with an empty party, which is what makes it
  // start on the battle menu with no mon out. The wild mon is the one the
  // `loadwildmon RATTATA, 5` in front of the command left behind.
  startCatchTutorial(wild: any, battleType: any, onDone?: () => void): boolean {
    const game = this.game;
    const data = game ? game.data : undefined;
    const save = game ? game.save : undefined;
    let mon: any;
    if (truthy(wild) && truthy(wild.species)) {
      const [id] = speciesByIndex(data ? data.pokemon : undefined, wild.species);
      mon = id ? Mon.new(data, id, wild.level ?? 5) : undefined;
    }
    if (!truthy(mon)) {
      // No wild mon means the script never ran `loadwildmon`, which no
      // reachable `catchtutorial` does. Hand the script straight back.
      if (onDone) onDone();
      return false;
    }
    const state = CatchTutorial.begin(save, game ? game.options : undefined);
    return this.startBattle({
      wild: mon,
      // The DUDE has no mon of his own: the battle opens on the menu.
      party: [],
      tutorial: true,
      battleType: truthy(battleType) ? battleType : CatchTutorial.BATTLETYPE_TUTORIAL,
    }, () => {
      CatchTutorial.finish(save, game ? game.options : undefined, state);
      if (onDone) onDone();
    });
  }

  // Lua: World.lua:7253-7261
  // Every `loadtrainer` and every `gettrainername` comes through here, which
  // is why the CAL2 redirect lives in TrainerHouse.lookup: ReadTrainerParty
  // tests the class before it indexes the parties table.
  trainerParty(clazz: any, member: any): any {
    return TrainerHouse.lookup(this.game && this.game.data
      ? this.game.data.trainers : undefined, this.game ? this.game.save : undefined, clazz, member);
  }

  // Lua: World.lua:7263-7312
  // MomTriesToBuySomething (engine/events/mom_phone.asm), reached from the
  // trainer arm of `reloadmapafterbattle`. core/MomShopping.ts owns the two
  // shopping lists and the balance walk; this is the map half plus the call.
  //
  // The cart does not SPEAK here: it `LoadMemScript`s the phone call and lets
  // the overworld pick it up. World:queuedScript is that same deferral --
  // runQueuedScript drains it on the first frame the overworld owns with no
  // text box open -- so the lines land after the trainer's own after-battle
  // script has finished. The ring is the call's own (.Script is `callasm
  // .ASMFunction / farsjump Script_ReceivePhoneCall`), so the rows ride the
  // PhoneRing chrome with PHONE_MOM as the caller.
  momTriesToBuy(): any {
    const save = this.game ? this.game.save : undefined;
    if (!truthy(save)) return undefined;
    const def = this.map ? this.map.def : undefined;
    const purchase = MomShopping.tryBuy(save, {
      events: this.events,
      data: this.game ? this.game.data : undefined,
      // RandomRange returns 0..n-1.
      random: (n: number) => random(n) - 1,
      // GetMapPhoneService: a map with no reception `ret`s before the balance
      // is looked at, so Mom simply tries again after the next trainer.
      phoneService: (def == null) || (def.phoneService !== false),
    });
    if (!purchase) return undefined;
    const script: Record<string, any>[] = [];
    for (const page of MomShopping.pages(purchase)) {
      // `rawtext`, not `writetext`: these strings sit in data/text/
      // common_1.asm behind a phone script the extractor never walks, so
      // there is no text key to name them by.
      script.push({ op: "rawtext", text: page });
    }
    script.push({ op: "end" });
    if (this.vm) this.vm.curPhoneCaller = Phone.PHONECONTACT_MOM;
    // The Lua hands PhoneRing a bare { contact, scriptKey = <row list> }.
    this.queuedScript = PhoneRing.script(
      { contact: Phone.PHONECONTACT_MOM, scriptKey: script } as any,
      Phone.NON_TRAINER_NAMES[Phone.PHONECONTACT_MOM]);
    // A doll changes what stands in the bedroom, and the room is rebuilt from
    // the flags on a MAP LOAD -- so nothing has to be dropped here.
    return purchase;
  }

  // Lua: World.lua:7314-7338
  // PlayTrainerEncounterMusic: the short jingle that plays while the trainer
  // walks up, one per class out of data/trainers/encounter_music.asm. NOT the
  // battle theme -- PlayBattleMusic replaces it when the transition starts.
  // A cache with no `encounterMusic` falls back to the shared trainer theme.
  playTrainerEncounterMusic(clazz: any): void {
    const data = this.game ? this.game.data : undefined;
    const audio = data ? data.audio : undefined;
    if (!(audio && audio.songs)) return;
    const entry = Trainers.classIndex(data.trainers)[clazz];
    const song = entry ? entry.encounterMusic : undefined;
    if (truthy(song) && song !== "Music_Nothing" && truthy(audio.songs[song])) {
      Music.play(data, song, true, { reason: "trainer_encounter" });
      return;
    }
    for (const name of ["Music_JohtoTrainerBattle", "Music_KantoTrainerBattle"]) {
      if (truthy(audio.songs[name])) {
        Music.play(data, name, true, { reason: "trainer_encounter" });
        return;
      }
    }
  }

  // Lua: World.lua:7340-7351
  // showemote: the bubble sits one cell above the object for `frames` frames,
  // riding the same camera as the NPC. `self.emote.image` is the bubble's gfx
  // KEY (load() keeps keys in emoteImages); World:step counts `left` down.
  showEmote(emote: any, object: any, frames: any): void {
    const sheet = this.emoteImages
      ? this.emoteImages[this.emoteOrder ? this.emoteOrder[emote ?? 0] : undefined]
      : undefined;
    // LAST_TALKED (-2) is the object the script is about; everything else is
    // a plain object id. (Lua `a and b or c`: a -2 with nobody talked to
    // falls through to objectEntity(-2).)
    let ent: any = object === -2
      ? (truthy(this.talkNpc) ? this.talkNpc : this.trainerNpc) : undefined;
    if (!truthy(ent)) ent = this.objectEntity(object ?? 0);
    if (!(truthy(sheet) && truthy(ent))) return;
    this.emote = { image: sheet, entity: ent, left: frames ?? 30 };
  }

  // Lua: World.lua:7393-7415
  // The special is BLOCKING: `onDone` is what resumes the script, so the
  // nurse's next line never comes up over the machine still running. The
  // cart's first guard is `ld a, [wPartyCount] / and a / ret z`, and a cache
  // with no sheet resumes the same way rather than hanging the script.
  startHealMachineAnim(animType: any, onDone?: () => void): void {
    const party = this.game && this.game.save ? this.game.save.party : undefined;
    const layout = HEAL_MACHINE_LAYOUT[animType ?? 0] ?? HEAL_MACHINE_LAYOUT[0]!;
    if (!(party && party.length > 0 && truthy(this.healMachineImage))) {
      if (onDone) onDone();
      return;
    }
    const p = this.player;
    const ha: HealAnimState = {
      layout,
      hof: animType === 2,
      balls: Math.min(party.length, layout.balls.length),
      lit: 0, timer: 0, phase: "balls", flashes: 0, rotation: 0,
      px: p ? p.cellX * 16 : 0,
      py: p ? p.cellY * 16 : 0,
      onDone,
    };
    this.healAnim = ha;
  }

  // Lua: World.lua:7417-7469
  // One frame of the machine, on the cart's own timeline: each party member's
  // ball lands with SFX.SECOND_PART_OF_ITEMFINDER then DelayFrames 30, then
  // MUSIC_HEAL plays over .FlashPalettes8Times -- eight rotations of the OBJ
  // palette ten frames apart. The Hall of Fame arm swaps the jingle for
  // SFX.GAME_FREAK_LOGO_GS and rings SFX.BOOT_PC once the flashing stops. The
  // special returns after the last flash's delay, which is when the balls clear.
  stepHealAnim(): void {
    const ha: HealAnimState | undefined = this.healAnim;
    if (!ha) return;
    ha.timer = ha.timer + 1;
    if (ha.phase === "balls") {
      if (ha.lit === 0 || ha.timer >= 30) {
        ha.timer = 0;
        if (ha.lit < ha.balls) {
          ha.lit = ha.lit + 1;
          this.playSfxNamed("Sfx_SecondPartOfItemfinder",
            SFX.SECOND_PART_OF_ITEMFINDER);
        } else {
          ha.phase = "flash";
          if (ha.hof) {
            this.playSfxNamed("Sfx_GameFreakLogoGs", SFX.GAME_FREAK_LOGO_GS);
          } else {
            // .PlayHealMusic. playOnce hands the map its theme back when the
            // jingle ends; the script's own `pause 30` + RestartMapMusic behind
            // the special covers a cache whose song is missing.
            Music.playOnce(this.game.data, "Music_HealPokemon");
          }
        }
      }
    } else if (ha.phase === "flash") {
      // FlashPalettes8Times flashes FIRST and then delays, so the first
      // rotation lands on the same frame the jingle starts.
      if (ha.flashes === 0 || ha.timer >= 10) {
        ha.timer = 0;
        if (ha.flashes >= 8) {
          if (ha.hof) {
            this.playSfxNamed("Sfx_BootPc", SFX.BOOT_PC);
          }
          const done = ha.onDone;
          delete this.healAnim;
          if (done) done();
          return;
        }
        ha.flashes = ha.flashes + 1;
        // The CGB arm of .FlashPalettes rotates the four colours one slot per
        // flash; 8 % 4 lands the palette back where it started.
        ha.rotation = mod(ha.flashes, 4);
      }
    }
  }

  // Lua: World.lua:7471-7523 drawHealAnim: drawing, replaced by viewState()
  // (it reads self.healAnim -- see HealAnimState -- and mutates nothing but
  // its own lazily built quads).

  // Lua: World.lua:7525-7552
  // The PokemonCenterPC / PlayersHousePC specials: push that PC's screen. The
  // script is parked on the VM's own resume, so the PC's own B closes it and
  // the rest of the script continues. `opts.house` is _PlayersHousePC: the
  // center's is the whose-PC top menu (ui/CenterPcMenu.ts), the bedroom's is
  // the item PC alone (ui/ItemPcMenu.ts, PLAYERSPC_HOUSE). The bedroom's
  // `onDone` gets the c the cart returns -- TRUE only if a decoration moved,
  // which is what makes PlayersHousePCScript take its `.Warp` arm.
  openPc(opts?: any): boolean {
    opts = opts ?? {};
    const game = this.game;
    if (!(game && game.stack)) {
      if (opts.onDone) opts.onDone(false);
      return false;
    }
    Screens.push(game, truthy(opts.house) ? "Gen2ItemPcMenu" : "Gen2CenterPcMenu", {
      save: game.save,
      house: opts.house,
      events: this.events,
      onClose: (changed: any) => {
        game.stack.pop();
        if (opts.onDone) opts.onDone(truthy(changed));
      },
    });
    return true;
  }

  // Lua: World.lua:7554-7568
  // ToggleDecorationsVisibility (PLAYERS_HOUSE_2F's MAPCALLBACK_NEWMAP). Both
  // halves of each row land here: the sprite byte in wVariableSprites and the
  // object's own event flag, which decides whether the object is built at
  // all. Called from a map callback, so it must not rebuild anything itself:
  // setMap has not laid the objects out yet when NEWMAP runs.
  toggleDecorationsVisibility(): void {
    const state = Decorations.state(this.game ? this.game.save : undefined);
    for (const row of Decorations.visibility(state)) {
      this.events.set(row.flag, row.hidden);
      if (!row.hidden) this.variableSprites[row.sprite] = row.byte;
    }
  }

  // Lua: World.lua:7570-7583
  // ToggleMaptileDecorations (the MAPCALLBACK_TILES one). The blocks go
  // through World:changeBlock, so the edit is undone by the next
  // LoadMapAttributes -- which is right: the callback runs again on every
  // load and repaints from the same eight bytes.
  toggleMaptileDecorations(): void {
    const state = Decorations.state(this.game ? this.game.save : undefined);
    for (const tile of Decorations.tiles(state)) {
      this.changeBlock(tile.x, tile.y, tile.block);
    }
    // SetPosterVisibility, inline in the same routine: a bare wall is not
    // readable, so the poster's BGEVENT_IFSET flag follows the slot.
    this.events.set(Decorations.EVENT_PLAYERS_ROOM_POSTER,
      Decorations.posterVisible(state));
  }

  // Lua: World.lua:7585-7609
  // Script_pokemart -> OpenMartDialog (engine/items/mart.asm). The clerk's
  // whole conversation is one blocking screen on the cart, so the script parks
  // on the VM's resume and the mart's own QUIT lets the next command run.
  openMart(martType: any, martId: any, onDone?: () => void): boolean {
    const game = this.game;
    if (!(game && game.stack)) {
      if (onDone) onDone();
      return false;
    }
    Screens.push(game, "Gen2MartMenu", {
      save: game.save,
      items: game.data ? game.data.items : undefined,
      marts: this.marts,
      martType,
      martId,
      // text carries the clerk's whole conversation, seeded by name.
      text: this.text,
      onClose: () => {
        game.stack.pop();
        if (onDone) onDone();
      },
    });
    return true;
  }

  // Lua: World.lua:7611-7643
  // `loadmenu` then `verticalmenu` / `_2dmenu`: the static menu a script puts
  // up. The header arrives with its box, its flags and its item strings; a
  // cache with only the raw address has nothing to draw, and the honest
  // answer is the one StaticMenuJoypad gives for B. The menu is NOT opaque:
  // the cart leaves the script's text box underneath it.
  openScriptMenu(header: any, style: any, onChoose?: (index: number) => void): boolean {
    const game = this.game;
    const items = header ? (truthy(header.items) ? header.items : header.gridItems) : undefined;
    // The balance box a `special` left standing (showCoins / showMoney).
    // Consumed here whether or not the menu opens: CloseWindow takes the box
    // down with the menu, so it must not survive into the next one.
    const balance = this.scriptBalance;
    delete this.scriptBalance;
    if (!(game && game.stack) || !truthy(items) || items.length === 0) {
      if (onChoose) onChoose(0);
      return false;
    }
    Screens.push(game, "Gen2ScriptMenu", {
      header,
      style,
      balance,
      save: game.save,
      onChoose: (index: number) => {
        game.stack.pop();
        if (onChoose) onChoose(index);
      },
    });
    return true;
  }

  // Lua: World.lua:7645-7668
  // `trade trade_id` -> NPCTrade (engine/events/npc_trade.asm), the whole
  // blocking conversation off data/events/npc_trades.asm. NPCTrade writes no
  // wScriptVar, so the script carries on either way.
  openNpcTrade(id: any, onDone?: () => void): boolean {
    const game = this.game;
    if (!(game && game.stack)) {
      if (onDone) onDone();
      return false;
    }
    Screens.push(game, "Gen2TradeMenu", {
      trade: id,
      save: game.save,
      eventTables: this.eventTables,
      onClose: () => {
        game.stack.pop();
        if (onDone) onDone();
      },
    });
    return true;
  }

  // Lua: World.lua:7670-7709
  // `elevator floor_list` -> Elevator (engine/events/elevator.asm). Find the
  // row for the floor the player got in on (wBackupMapNumber, the map they
  // warped in FROM), ask which floor, then Elevator_GoToFloor -- which does
  // not warp: it writes the chosen row into wBackupWarpNumber /
  // wBackupMapGroup / wBackupMapNumber, and the elevator's own -1 door reads
  // them. `.FindCurrentFloor` failing is `scf`: no menu at all.
  openElevator(floors: any, onDone?: (row?: any) => void): boolean {
    const game = this.game;
    const rows: any[] = [];
    for (const row of seq_W5(floors)) {
      if (truthy(row.destMap) && truthy(this.maps[row.destMap])) rows.push(row);
    }
    let origin: any;
    for (const row of rows) {
      if (row.destMap === this.backupMapId) { origin = row; break; }
    }
    if (!(game && game.stack) || !truthy(origin)) {
      if (onDone) onDone(undefined);
      return false;
    }
    Screens.push(game, "Gen2ElevatorMenu", {
      floors: rows,
      currentMap: this.backupMapId,
      floorNames: this.eventTables.floorNames,
      onDone: (row: any) => {
        game.stack.pop();
        if (truthy(row)) {
          this.backupWarp = { warp: row.destWarp, map: row.destMap };
        }
        if (onDone) onDone(row);
      },
    });
    return true;
  }

  // Lua: World.lua:7711-7724
  // Pokecenter heal (the HealParty special): full HP, full PP, no status, for
  // every party member. Also what a whiteout does before warping home.
  healParty(): void {
    const save = this.game ? this.game.save : undefined;
    for (const mon of seq_W5((save && truthy(save.party)) ? save.party : [])) {
      mon.hp = mon.maxHp ?? mon.hp;
      delete mon.status;
      delete mon.statusTurns;
      for (const move of seq_W5(mon.moves)) {
        if (move !== null && typeof move === "object") move.pp = move.maxPp ?? move.pp;
      }
    }
  }

  // Lua: World.lua:7726-7774
  // The rival naming screen (the NameRival special, engine/events/
  // specials.asm): `farcall _NamingScreen` does not return until the keyboard
  // closes, and only then does InitName fall back to the version default for
  // an empty entry. `onDone` is that return: H.NameRival parks the script on
  // it, and the screen's close is what resumes the officer.
  nameRival(onDone?: (name?: any) => void): void {
    const game = this.game;
    if (!(game && game.stack)) {
      if (onDone) onDone();
      return;
    }
    const data = game.data ?? {};
    const sprites = data.gen2Sprites;
    const rival = sprites ? sprites.SPRITE_RIVAL : undefined;
    Screens.push(game, "Gen2NamingScreen", {
      type: "rival",
      menuGfx: data.gen2MenuGfx,
      iconPath: rival ? (rival.image ?? undefined) : undefined,
      iconColors: truthy(data.gen2Palettes)
        ? (Palettes.spritePalette(data.gen2Palettes, this.daytime ?? "DAY", rival) ?? undefined)
        : undefined,
      onDone: (name: any) => {
        game.stack.pop();
        const save = game.save;
        if (truthy(save)) {
          save.rival = save.rival ?? {};
          // NameRival ends on `ld hl, wRivalName / ld de, .DefaultName / call
          // InitName`, and .DefaultName is "SILVER@" on Gold and "GOLD@" on
          // Silver (engine/events/specials.asm:80-94). Written HERE rather
          // than from the seed: wRivalName starts as InitializeNPCNames'
          // "???", which the pre-naming Cherrygrove battle prints.
          //
          // _InitString defines blank as "zero or more spaces followed by a
          // null" (home/string.asm:6-30), so an all-spaces entry falls back
          // exactly the same way an empty one does.
          if (name != null && String(name).replace(/ /g, "") !== "") {
            save.rival.name = name;
          } else {
            save.rival.name = this.gsVersion() === 1 ? "GOLD" : "SILVER";
          }
        }
        if (onDone) onDone(name);
      },
    });
  }

  // Lua: World.lua:7776-7797
  // home/map.asm LoadMapAttributes .SetSpawn. `def` is the map being loaded;
  // self.map is still the one being left.
  updateWhiteoutSpawn(def: any, mapId: any): void {
    if (!truthy(def)) return;
    const prev = this.map ? this.map.def : undefined;
    if (!truthy(prev)) return;
    // CheckOutdoorMap on the map being left, CheckIndoorMap on the one being
    // entered, then its tileset. All three, in that order.
    if (!(prev.environment === "ROUTE" || prev.environment === "TOWN")) {
      return;
    }
    if (def.environment !== "INDOOR") return;
    if (def.tileset !== "TILESET_POKECENTER") return;
    // `ld a, [wPrevMapGroup] / ld [wLastSpawnMapGroup], a`: what is stored is
    // the map being LEFT -- the town or route outside the door. It is what
    // makes the Indigo Plateau centre work: it is entered from ROUTE_23, and
    // SPAWN_INDIGO is ROUTE_23 (9,6).
    const save = this.game ? this.game.save : undefined;
    if (truthy(save)) save.blackoutMap = truthy(prev.id) ? prev.id : mapId;
  }

  // Lua: World.lua:7799-7842
  // GetWhiteoutSpawn's answer WITHOUT taking it: where a whiteout would land,
  // as { map, x, y, spawn }, or undefined when nothing resolves. Split out of
  // warpToSpawn so world.blacked_out can carry the same healTarget key Gen 1's
  // OverworldState:healPoint fills.
  healPoint(): HealPoint | undefined {
    const save = this.game ? this.game.save : undefined;
    // wLastSpawnMapGroup / wLastSpawnMapNumber, written by `blackoutmod`, are
    // read BEFORE the SPAWN_* table: the Fast Ship and Mr. Pokemon's house set
    // them so losing at sea does not respawn the player somewhere they cannot
    // leave.
    const override = save ? save.blackoutMap : undefined;
    if (truthy(override)) {
      // GetWhiteoutSpawn's own lookup: the stored map is matched against
      // SpawnPoints, keyed by the OUTDOOR map (`spawn PALLET_TOWN, 5, 6`),
      // which is exactly what World:updateWhiteoutSpawn stores. (Lua pairs();
      // walked in sortedKeys order here so the pick is stable.)
      const spawns = this.landmarks ? this.landmarks.spawns : undefined;
      if (spawns !== null && typeof spawns === "object") {
        for (const id of sortedKeys(spawns)) {
          const row = spawns[id];
          if (row !== null && typeof row === "object" && row.map === override
              && truthy(this.maps[row.map])) {
            return { map: row.map, x: row.x, y: row.y, spawn: id };
          }
        }
      }
      // Not a spawn point: `blackoutmod`'s other users (the Fast Ship cabins)
      // name maps that are not in the table at all, so fall back to the map
      // itself rather than sending the player home from the middle of the sea.
      if (truthy(this.maps[override])) {
        const def = this.maps[override];
        const warp = def.warps ? def.warps[0] : undefined;
        return { map: override, x: (warp ? warp.x : undefined) ?? 0,
                 y: (warp ? warp.y : undefined) ?? 0 };
      }
    }
    const spawnId = (save && truthy(save.spawn)) ? save.spawn : SPAWN_HOME;
    const spawn = this.landmarks && this.landmarks.spawns
      ? this.landmarks.spawns[spawnId] : undefined;
    if (!(spawn && truthy(spawn.map) && truthy(this.maps[spawn.map]))) return undefined;
    return { map: spawn.map, x: spawn.x, y: spawn.y, spawn: spawnId };
  }

  // Lua: World.lua:7844-7850
  // WarpToSpawnPoint: back to the last Pokecenter (or the bedroom before one
  // is visited), which is where a whiteout lands.
  warpToSpawn(): void {
    const target = this.healPoint();
    if (!target) return;
    this.setMap(target.map, target.x, target.y, "down");
  }

  // Lua: World.lua:7852-7859
  playCry(speciesIndex: any): void {
    const data = this.game ? this.game.data : undefined;
    if (!truthy(data)) return;
    const [id] = speciesByIndex(data.pokemon, speciesIndex);
    if (id) {
      this.lastSfx = Sound.playCry(data, id);
    }
  }

  // Lua: World.lua:7861-7869 -- sfxOrder is the 0-based JSON array of the
  // Lua's 1-based list, so SFX id n is sfxOrder[n].
  playSfx(sfxId: any): void {
    const data = this.game ? this.game.data : undefined;
    const audio = data ? data.audio : undefined;
    if (!truthy(audio)) return;
    const name = audio.sfxOrder ? audio.sfxOrder[sfxId ?? 0] : undefined;
    if (truthy(name) && audio.sfx && truthy(audio.sfx[name])) {
      this.lastSfx = Sound.play(data, name);
    }
  }

  // Lua: World.lua:7871-7886
  playMusicId(musicId: any): void {
    const data = this.game ? this.game.data : undefined;
    const audio = data ? data.audio : undefined;
    if (!(audio && truthy(audio.runtime))) return;
    const name = audio.musicOrder ? audio.musicOrder[musicId ?? 0] : undefined;
    // Script_playmusic with MUSIC_NONE is how a script silences the map ahead
    // of its own cue -- the nurse's `playmusic MUSIC_NONE` right before the
    // heal machine -- so it is a real stop, not a skipped play.
    if ((musicId ?? 0) === 0 || name === "Music_Nothing") {
      Music.stop();
      return;
    }
    if (truthy(name) && audio.songs && truthy(audio.songs[name])) {
      Music.play(data, name, true, { reason: "script_playmusic" });
    }
  }

  // Lua: World.lua:7888-7903
  tryCoordScript(): boolean {
    if (truthy(this.busy()) || !this.map || !this.player || !this.vm) {
      return false;
    }
    if (this.player.moving) return false;
    const scene = this.scene();
    const x = this.player.cellX, y = this.player.cellY;
    for (const ev of seq_W5(this.map.def.coordEvents)) {
      if (ev.x === x && ev.y === y && (ev.sceneId ?? 0) === scene
          && truthy(ev.scriptKey)) {
        delete this.talkNpc;
        return this.vm.start(ev.scriptKey);
      }
    }
    return false;
  }

  // Lua: World.lua:7905-7929 -- sceneScripts is keyed by scene id (the JSON
  // object's "0", "1", ...); the sceneId scan is the fallback for a list.
  trySceneScript(): boolean {
    if (!this.map || !this.vm) return false;
    const scene = this.scene();
    const scenes = this.map.def.sceneScripts;
    let entry = scenes ? scenes[scene] : undefined;
    if (!truthy(entry)) {
      // Prefer the explicit sceneId field (Lua pairs(); sortedKeys here).
      if (scenes !== null && typeof scenes === "object") {
        for (const k of sortedKeys(scenes)) {
          const s = scenes[k];
          if (s !== null && typeof s === "object" && s.sceneId === scene && truthy(s.scriptKey)) {
            entry = s;
            break;
          }
        }
      }
    }
    const key = truthy(entry) ? (truthy(entry.scriptKey) ? entry.scriptKey : entry.script) : undefined;
    if (typeof key === "number") return false;
    if (truthy(key)) {
      delete this.talkNpc;
      return this.vm.start(key);
    }
    return false;
  }

  // Lua: World.lua:7931-8000
  // `stay` is the VM's one-command lookahead (Vm:textStays): the next script
  // command is `yesorno`, so this text ends in `done` and the cart never took
  // the box down before InitYesNoTextBoxParameters put the prompt over it.
  // The box is left standing and World:askYesNo stacks the choice on THIS box.
  //
  // `hold` is the cart's `pause` when that pause sits INSIDE the box:
  // FindItemInBallScript is `writetext .FoundItemText / playsound SFX.ITEM /
  // pause 60 / itemnotify` (engine/events/misc_scripts.asm:13-17). It cannot
  // be a VM `pause` here, because Game2:update stops at the top state -- while
  // ANY box is on the stack the overworld and the VM under it do not tick --
  // so the box itself counts it. Frames, already doubled by Vm:pauseFrames.
  // ../pokecrystal/home/joypad.asm:302 WaitButton
  showText(body: any, onDone?: () => void, stay?: any, hold?: any, sfxWait?: any, arrows?: any): void {
    const waitButton = !truthy(arrows);
    const game = this.game;
    // The box a PREVIOUS `stay` left standing (TextBox's contract is "whoever
    // pushed it owns the pop"). `yesorno` consumes it in World:askYesNo; the
    // other consumer is the next page of the same cart MapTextbox. The pop and
    // the push happen inside ONE frame, so no frame renders the bare overworld
    // between two pages the cart never took a box down between.
    const held = this.stayedTextBox;
    delete this.stayedTextBox;
    if (!game || !game.stack) {
      if (onDone) onDone();
      return;
    }
    if (truthy(held) && game.stack.top() === held) game.stack.pop();
    this.textbox = true;
    // Kept for `yesorno`, which re-shows this page under the prompt.
    this.lastText = body;
    if (truthy(stay)) {
      let box: TextBox;
      let left: number | undefined = (hold ?? 0) > 0 ? hold : undefined;
      box = TextBox.new(game, body, undefined, {
        // stay.onShown fires on the frame the last page finishes typing,
        // which is where PrintText returns on the cart (#591).
        stay: { onShown: () => {
          this.stayedTextBox = box;
          // The `hold` above. TextBox's own page/CONT block counter is the one
          // per-frame gate a finished box already has, and clearing
          // `stayShown` re-arms this hook for the frame it drains on -- so the
          // box sits there for the length of the cart's pause and THEN hands
          // the script back. A stay box reads no input and pops for nothing.
          if (left != null) {
            box.holdFrames = left;
            box.stayShown = false;
            left = undefined;
            return;
          }
          if (onDone) onDone();
        } },
        waitButton,
      });
      game.stack.push(box);
      return;
    }
    game.stack.push(TextBox.new(game, body, () => {
      delete this.textbox;
      if (onDone) onDone();
    }, { sfxWait: truthy(sfxWait) ? true : undefined, waitButton }));
  }

  // Lua: World.lua:8002-8037
  pooledNpc(mapId: any, obj: any): NPC | undefined {
    if (!truthy(this.sprites) || !truthy(obj) || !truthy(obj.sprite)) return undefined;
    // An object whose `sprite` is a NUMBER names a wVariableSprites slot
    // rather than a sheet (Route 36's Sudowoodo carries $f4), and only
    // `variablesprite` can say what stands there. Unfilled, it stays nil and
    // nothing spawns -- exactly what the cart draws before the scene script.
    const name = this.resolveSprite(obj.sprite);
    if (!truthy(name)) return undefined;
    // The day-care pair's species is whatever is being bred, so
    // resolveSprite answers with the built def itself rather than a name.
    const spriteDef = (name !== null && typeof name === "object") ? name : this.sprites[name];
    if (!truthy(spriteDef)) return undefined;
    const key = format("%s_obj_%d", mapId, obj.index ?? 0);
    let npc: NPC | undefined = this.npcPool[key];
    if (!npc) {
      npc = NPC.new(mapId, obj, spriteDef);
      this.npcPool[key] = npc;
      // applyPalettes only runs on map entry and once a second, so an NPC
      // created after that -- anything an event flag reveals part way through
      // a map's life -- would draw unbaked until the next poll.
      this.applySpritePalette(npc);
      // Gen 1's pooledNPC emits the same three keys from the same place -- the
      // pool miss. `runtime` is always false: every object came out of the
      // map def (Gold has no runtime-object system, see WorldAPI:spawnNpc).
      if (Runtime.wants("world.npc_spawned")) {
        Runtime.emit("world.npc_spawned",
          { mapId, npcId: key, runtime: false });
      }
    }
    return npc;
  }

  // Lua: World.lua:8055-8061 -- TimesOfDay (engine/rtc/rtc.asm): 0400-0959
  // morn, 1000-1759 day, else nite.
  clockTimeMask(): number {
    const hour = this.hour();
    if (hour >= 4 && hour < 10) return MORN_MASK;
    if (hour >= 10 && hour < 18) return DAY_MASK;
    return NITE_MASK;
  }

  // Lua: World.lua:8063-8079 -- `hours` is the object's 0-based [h1, h2].
  objectTimeVisible(obj: any): boolean {
    const hours = obj ? obj.hours : undefined;
    if (!truthy(hours)) return true;
    const h1 = hours[0] ?? -1;
    const h2 = hours[1] ?? -1;
    if (h1 === -1) {
      if (h2 === -1) return true;
      const mask = this.clockTimeMask();
      return mod(h2, mask * 2) >= mask;
    }
    if (h1 === h2) return true;
    const hour = this.hour();
    if (h1 < h2) {
      return hour >= h1 && hour <= h2;
    }
    return hour >= h1 || hour <= h2;
  }

  // Lua: World.lua:8081-8086 -- wObjectMasks, one byte per object_event
  // (home/map.asm:1534 CheckObjectMask). Tri-state: true masked, false
  // unmasked, undefined "no mask loaded", the only case that falls back to
  // deriving visibility from the event flag. `index` is the 1-based object
  // number, used only when the object carries no `index` of its own.
  objectMaskKey(obj: any, index?: any): string {
    return format("%s:%d", this.map.id, (obj ? obj.index : undefined) ?? index ?? 0);
  }

  // Lua: World.lua:8088-8097 -- MaskObject / UnmaskObject (home/map.asm:1542,
  // :1548): ONE byte, this object's. `maskScripted` remembers that a script
  // wrote it, so the hour poll cannot resurrect somebody a scene took off.
  setObjectMask(obj: any, index: any, masked: any): void {
    this.objectMasks = this.objectMasks ?? {};
    this.maskScripted = this.maskScripted ?? {};
    const key = this.objectMaskKey(obj, index);
    this.objectMasks[key] = truthy(masked);
    this.maskScripted[key] = true;
  }

  // Lua: World.lua:8099-8124
  // LoadObjectMasks (engine/overworld/map_objects_2.asm:1): ByteFill over the
  // whole array, then one GetObjectTimeMask / CheckObjectFlag per object. The
  // ONLY place the event flags decide who is on the map; after it, an
  // `appear` or `disappear` moves its own byte and a plain `setflag` moves
  // nobody until the next load. LoadMapObjects runs it AFTER
  // MAPCALLBACK_OBJECTS, which is why the reset is unconditional. The hour
  // poll passes keepScripted, since it stands in for a reload the cart does
  // not actually run.
  loadObjectMasks(opts?: any): void {
    opts = opts ?? {};
    const scripted: Record<string, boolean> =
      (truthy(opts.keepScripted) && truthy(this.maskScripted)) ? this.maskScripted : {};
    const masks: Record<string, boolean> =
      truthy(opts.keepScripted) ? (this.objectMasks ?? {}) : {};
    const def = this.map ? this.map.def : undefined;
    const objects = seq_W5(def ? def.objects : undefined);
    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      const key = this.objectMaskKey(obj, i + 1);
      if (!scripted[key]) {
        masks[key] = !(truthy(this.events.objectVisible(obj.eventFlag))
          && this.objectTimeVisible(obj));
      }
    }
    this.objectMasks = masks;
    this.maskScripted = scripted;
  }

  // Lua: World.lua:8126-8140 -- InitializeVisibleSprites
  // (engine/overworld/player_object.asm:223)
  objectSpawnable(obj: any): boolean {
    const map = this.map;
    const def = map ? map.def : undefined;
    const wCells = (map && truthy(map.widthCells)) ? map.widthCells
      : (def && truthy(def.width) ? def.width * 2 : undefined);
    const hCells = (map && truthy(map.heightCells)) ? map.heightCells
      : (def && truthy(def.height) ? def.height * 2 : undefined);
    if (!(truthy(obj) && wCells != null && hCells != null)) return true;
    const ox = obj.x ?? 0, oy = obj.y ?? 0;
    if (ox >= 0 && oy >= 0 && ox < wCells && oy < hCells) return true;
    const px = (this.player ? this.player.cellX : undefined) ?? 0;
    const py = (this.player ? this.player.cellY : undefined) ?? 0;
    const dx = ox - px, dy = oy - py;
    return dx >= -5 && dx < 7 && dy >= -5 && dy < 6;
  }

  // Lua: World.lua:8142-8212
  // Current-map NPCs + visual-only ghosts on neighbor strips (Gen 1 pattern).
  // `peopleFromMap` (the Lua's set keyed by NPC table) is a JS Set.
  rebuildPeople(opts?: any): void {
    opts = opts ?? {};
    // Anything this function did not put in the list is a GUEST: the follower
    // (world/Follower.ts) or a mod's own entity. A rebuild runs on every zoom
    // and time-of-day roll, so wiping guests would lose a follower at the top
    // of the hour.
    const made: Set<any> = this.peopleFromMap ?? new Set<any>();
    let guests: any[] | undefined;
    for (const npc of seq_W5(this.npcs)) {
      // Only this map's: a warp respawns rather than dragging one across a seam.
      if (!made.has(npc) && (npc.mapId == null || npc.mapId === this.map.id)) {
        guests = guests ?? [];
        guests.push(npc);
      }
    }
    const fromMap = new Set<any>();
    this.peopleFromMap = fromMap;
    if (!truthy(opts.seamless) || !truthy(this.npcPool)) {
      this.npcPool = {};
    }
    this.npcs = [];
    this.entities = [];
    if (this.player) {
      this.entities.push(this.player);
    }
    for (const obj of seq_W5(this.map.def.objects)) {
      // wObjectMasks is what says who is standing here (CheckObjectMask,
      // home/map.asm:1534): the flags only reach it through LoadObjectMasks,
      // at map load. A world that never ran setMap has no masks at all, so
      // undefined falls back to the derivation LoadObjectMasks would do.
      let masked: any = this.objectMasks ? this.objectMasks[this.objectMaskKey(obj)] : undefined;
      if (masked == null) {
        masked = !(truthy(this.events.objectVisible(obj.eventFlag))
          && this.objectTimeVisible(obj));
      }
      if (!masked && this.objectSpawnable(obj)) {
        const npc = this.pooledNpc(this.map.id, obj);
        if (npc) {
          fromMap.add(npc);
          this.npcs.push(npc);
          this.entities.push(npc);
        }
      }
    }
    for (const npc of guests ?? []) {
      this.npcs.push(npc);
      this.entities.push(npc);
    }
    this.ghosts = [];
    for (const nb of seq_W5<{ id: string; ox: number; oy: number }>(this.neighbors)) {
      const def = this.maps[nb.id];
      if (truthy(def)) {
        const tileset = this.tilesets[def.tileset];
        const ghostMap = truthy(tileset) ? Map.new(def, tileset) : undefined;
        const peers: NPC[] = [];
        for (const obj of seq_W5(def.objects)) {
          if (truthy(this.events.objectVisible(obj.eventFlag))
              && this.objectTimeVisible(obj)) {
            const npc = this.pooledNpc(nb.id, obj);
            if (npc && ghostMap) {
              peers.push(npc);
              this.ghosts.push({
                npc, map: ghostMap, ox: nb.ox, oy: nb.oy, peers,
              });
            }
          }
        }
      }
    }
  }

  // Lua: World.lua:8214-8239
  // Mod-spawned map objects. The Gen 1 arm appends straight onto the map
  // def's object list, and the same move works here: World.maps is one table
  // for the whole run and rebuildPeople reads self.map.def.objects, so an
  // appended object is pooled, drawn, walked and talked to like an extracted
  // one, and survives a map reload. Not serialized. A runtime object carries
  // no eventFlag, so LoadObjectMasks' derivation leaves it visible.
  // Returns the TUPLE [npcId] on success or [undefined, err] (Lua `nil, err`);
  // WorldAPI:spawnNpc passes both through.
  addRuntimeObject(mapId: any, objDef: any, owner: any): [string | undefined, string?] {
    const def = this.maps ? this.maps[mapId] : undefined;
    if (!truthy(def)) return [undefined, "unknown map: " + tostring(mapId)];
    def.objects = def.objects ?? [];
    let index = 0;
    for (const obj of seq_W5(def.objects)) {
      if ((obj.index ?? 0) > index) index = obj.index;
    }
    objDef.index = index + 1;
    objDef.runtime = true;
    objDef.owner = owner;
    def.objects.push(objDef);
    const npcId = mapId + "_obj_" + objDef.index;
    if (this.map && this.map.id === mapId) {
      this.rebuildPeople({ seamless: true });
    }
    return [npcId];
  }

  // Lua: World.lua:8241-8261 -- imported objects are refused, and so is
  // another mod's. Returns the TUPLE [true] or [undefined, err]. (Lua pairs()
  // over maps; sortedKeys here.)
  removeRuntimeObject(npcId: any, owner: any): [true | undefined, string?] {
    const maps = this.maps ?? {};
    for (const mapId of sortedKeys(maps)) {
      const def = maps[mapId];
      const objects = seq_W5(def.objects);
      for (let i = 0; i < objects.length; i++) {
        const obj = objects[i];
        if (truthy(obj.runtime) && mapId + "_obj_" + obj.index === npcId) {
          if (owner != null && obj.owner !== owner) {
            return [undefined, "not owned by " + tostring(owner)];
          }
          objects.splice(i, 1);
          if (this.npcPool) {
            delete this.npcPool[format("%s_obj_%d", mapId, obj.index)];
          }
          if (this.map && this.map.id === mapId) {
            this.rebuildPeople({ seamless: true });
          }
          return [true];
        }
      }
    }
    return [undefined, "no such runtime object: " + tostring(npcId)];
  }

  // Lua: World.lua:8263-8274
  // IsNPCAtCoord (engine/overworld/npc_movement.asm), which is what BOTH the
  // step's `.CheckNPC` and the A press's CheckFacingObject ask -- so a
  // BIG_OBJECT fills its whole 2x2 blob for collision and for talking alike.
  // NPC:covers is WillObjectIntersectBigObject. The Lua calls it as
  // NPC.covers(npc, ...) on every entry, guests included, so it is applied
  // the same way here.
  npcAt(cx: any, cy: any): any {
    for (const npc of seq_W5(this.npcs)) {
      if (NPC.prototype.covers.call(npc, cx, cy)) return npc;
    }
    return undefined;
  }

  // Lua: World.lua:8276-8280 -- Gen 1's spelling, for the reason the Map
  // vocabulary aliases exist: a mod holds one name.
  npcAtCell(cx: any, cy: any): any {
    return this.npcAt(cx, cy);
  }

  // Lua: World.lua:8305-8328 -- BGEventJumptable (see BGEVENT_FACING).
  bgEventAt(cx: any, cy: any): any {
    for (const ev of seq_W5(this.map.def.bgEvents)) {
      if (ev.x === cx && ev.y === cy) {
        const kind = ev.kind ?? 0;
        if (kind === 0) {
          return ev;
        } else if (BGEVENT_FACING[kind]) {
          if (this.player && this.player.facing === BGEVENT_FACING[kind]) {
            return ev;
          }
        } else if (kind === 5 || kind === 6) {
          // CheckBGEventFlag, then `.ifset` reads when set and `.ifnotset`
          // when clear. An extraction with no `event` field is refused rather
          // than running the door script unconditionally.
          if (ev.event != null && truthy(ev.scriptKey)) {
            const set = this.events ? truthy(this.events.get(ev.event)) : false;
            if ((kind === 5) === set) return ev;
          }
        }
      }
    }
    return undefined;
  }

  // ---- trainers ------------------------------------------------------------

  // Lua: World.lua:8373-8376
  trainerBeaten(record: any): boolean {
    if (!(record && record.event != null)) return false;
    return truthy(this.events.get(record.event));
  }

  // Lua: World.lua:8383-8388
  refuseTrainer(record: any): void {
    const key = trainerKey(record);
    if (!key) return;
    this.refusedTrainers = this.refusedTrainers ?? {};
    this.refusedTrainers[key] = true;
  }

  // Lua: World.lua:8390-8394
  trainerRefused(record: any): boolean {
    const key = trainerKey(record);
    if (!(key && this.refusedTrainers)) return false;
    return truthy(this.refusedTrainers[key]);
  }

  // Lua: World.lua:8396-8416
  // _CheckTrainerBattle: every visible, unbeaten trainer object that is
  // facing the player along a shared row or column, within its own sight
  // range. Trainers.sees answers the Lua's two results (distance, dir) as a
  // tuple; `?? []` also takes a bare undefined.
  checkTrainerBattle(): boolean {
    if (truthy(this.busy()) || !this.player || !this.vm) return false;
    if (this.player.moving) return false;
    const save = this.game ? this.game.save : undefined;
    if (!(save && save.party && save.party.length > 0)) return false;
    for (const npc of seq_W5(this.npcs)) {
      const record = npc.def ? npc.def.trainer : undefined;
      if (truthy(record) && !this.trainerBeaten(record)
        && !this.trainerRefused(record)) {
        const [distance, dir] = Trainers.sees(npc, this.player, npc.def.sight) ?? [];
        if (distance != null) {
          return this.startTrainerScript(npc, SEEN_BY_TRAINER_SCRIPT, {
            distance, dir,
          });
        }
      }
    }
    return false;
  }

  // Lua: World.lua:8418-8441
  // Both entries to a map trainer -- the sight cone and an A press on one --
  // come through here, which is why world.trainer_engaged sits at this seam.
  // trainerClass and partyIndex hold the `trainer` struct's numeric class
  // constant and member number; `trainerEvent` and `sight` are Gen 2
  // additions.
  startTrainerScript(npc: any, script: any, sight: any): boolean {
    const record = npc && npc.def ? npc.def.trainer : undefined;
    if (truthy(record) && Runtime.wants("world.trainer_engaged")) {
      Runtime.emit("world.trainer_engaged", {
        npc, trainerClass: record.class, partyIndex: record.member,
        trainerEvent: record.event, sight,
      });
    }
    this.talkNpc = npc;
    this.freezeNpc(npc);
    this.cancelMapNameSign();
    this.vm.trainerObject = npc.def.trainer;
    this.trainerSight = sight;
    this.trainerNpc = npc;
    return this.vm.start(script);
  }

  // Lua: World.lua:8443-8453
  // The engaged / talked-to object holds still for the whole conversation
  // (Script_applymovement -> FreezeAllOtherObjects; a talked-to wanderer is
  // the script's LAST_TALKED). World:step unfreezes the pool the frame the
  // interaction is over, which is EndScript's UnfreezeAllObjects.
  freezeNpc(npc: any): void {
    if (truthy(npc)) npc.frozen = true;
    this.frozeNpcs = true;
  }

  // Lua: World.lua:8455-8475
  // TrainerWalkToPlayer: close to one cell short of the player, then hand the
  // VM back control. A trainer spotted from one cell away never moves.
  trainerApproach(onDone?: () => void): void {
    const sight = this.trainerSight;
    const npc = this.trainerNpc;
    if (!(truthy(sight) && truthy(npc))) {
      if (onDone) onDone();
      return;
    }
    const steps = Trainers.approach(sight.distance, sight.dir);
    if (steps.length === 0) {
      if (onDone) onDone();
      return;
    }
    const bytes: number[] = [];
    for (const dir of steps) {
      bytes.push(Movement.stepByte(dir));
    }
    bytes.push(Movement.STEP_END);
    this.beginMovement(npc.def.index + 1, bytes, onDone);
  }

  // Lua: World.lua:8506-8515
  // A-press: talk to facing NPC, read a sign (BGEVENT_READ) or dig up a
  // hidden item (BGEVENT_ITEM). Split so a replaced
  // `OverworldController.interact` sits in front of the body
  // (shared/mods/Gen2Compat.ts); unpatched, this is one comparison.
  interact(): any {
    const wrapped = Gen1Facade.interactWrapper();
    if (wrapped) return wrapped(this);
    return this.interactBody();
  }

  // Lua: World.lua:8517-8535
  // CheckFacingObject (engine/overworld/npc_movement.asm:229-248): "Double
  // the distance for counter tiles." A Pokecenter nurse and a Mart clerk
  // stand BEHIND a COLL_COUNTER tile. Only the OBJECT lookup is doubled: bg
  // events and the tile-collision events still read the tile actually faced.
  // Returns the TUPLE [x, y] (Lua's two results), or undefined with no player.
  facingObjectCell(): [number, number] | undefined {
    const p = this.player;
    if (!p) return undefined;
    const d = Map.DELTA[p.facing] ?? Map.DELTA.down;
    const fx = p.cellX + d[0], fy = p.cellY + d[1];
    if (this.map && Permissions.isCounter(this.map.cellCollision(fx, fy))) {
      return [p.cellX + d[0] * 2, p.cellY + d[1] * 2];
    }
    return [fx, fy];
  }

  // Lua: World.lua:8537-8545 -- the carry CheckFacingObject answers with:
  // IsNPCAtCoord, and then only when that object's OBJECT_WALKING reads
  // STANDING (npc_movement.asm:250-266).
  facingObject(): any {
    const cell = this.facingObjectCell();
    if (!cell) return undefined;
    const npc = this.npcAt(cell[0], cell[1]);
    if (npc && npc.moving) return undefined;
    return npc;
  }

  // Lua: World.lua:8547-8682
  interactBody(): boolean {
    if (truthy(this.busy()) || !this.player || !this.vm) return false;
    const p = this.player;
    if (p.moving) return false;
    // engine/overworld/events.asm:505-510
    if (p.stopForEvent) p.stopForEvent();
    delete this.turningDirection;
    const d = Map.DELTA[p.facing]!;
    const fx = p.cellX + d[0], fy = p.cellY + d[1];
    const cell = this.facingObjectCell();
    const npc = cell ? this.npcAt(cell[0], cell[1]) : undefined;
    // TryObjectEvent writes hLastTalked for EVERY A-press dispatch; scripts
    // then use LAST_TALKED (`disappear`, `applymovementlasttalked`) without a
    // setlasttalked of their own -- else SmashRockScript's `disappear
    // LAST_TALKED` hid whichever object an earlier conversation had named.
    // Object consts are index + 1, the same mapping disappearObject decodes.
    if (npc && npc.def && this.vm) {
      this.vm.lastTalked = (npc.def.index ?? 0) + 1;
    }
    // The Gen 1 dispatch a follower mod wraps is OverworldState:talkTo(npc),
    // which has no single Gen 2 method: Gold dispatches inline from here.
    // Same shape as interactWrapper -- nil unless something replaced it, and
    // a true return suppresses the built-in path.
    if (npc) {
      const talkTo = Gen1Facade.talkToWrapper();
      if (talkTo && truthy(talkTo(this, npc))) return true;
    }
    if (npc && npc.def && truthy(npc.def.trainer)
      && !this.trainerRefused(npc.def.trainer)) {
      interacted(this, fx, fy, "trainer", npc);
      return this.startTrainerScript(npc, TALK_TO_TRAINER_SCRIPT, undefined);
    }
    // Any other object an A press lands on holds still too (see freezeNpc).
    if (npc) this.freezeNpc(npc);
    // Every strength boulder in the game carries `jumpstd
    // StrengthBoulderScript`, a bare `farsjump AskStrengthScript` into ASM
    // with no bytecode behind it, so the boulder arm is handled here rather
    // than through the VM.
    if (npc && truthy(World.isStrengthBoulder(npc))) {
      this.talkNpc = npc;
      interacted(this, fx, fy, "boulder", npc);
      return this.tryStrengthOW();
    }
    // OBJECTTYPE_ITEMBALL: no scriptKey to start -- the object's pointer is
    // the raw (item, quantity) pair, read by the extractor into `itemball`.
    // Every plain Poke Ball on the floor comes through here.
    if (npc && npc.def && truthy(npc.def.itemball)) {
      this.talkNpc = npc;
      interacted(this, fx, fy, "itemball", npc);
      return this.vm.start(HiddenItems.ballPickupScript(
        npc.def.itemball.item, npc.def.itemball.quantity,
        (npc.def.index ?? 0) + 1,
        // The same resolver the itemfinder gets: the script names its sfx by
        // pokegold LABEL and this looks it up in THIS cache's sfx table.
        (want: any, id: any) => this.sfxIdNamed(want, id)));
    }
    if (npc && npc.def && truthy(npc.def.scriptKey)) {
      this.talkNpc = npc;
      interacted(this, fx, fy, "npc", npc);
      return this.vm.start(npc.def.scriptKey);
    }
    const sign = this.bgEventAt(fx, fy);
    if (sign && truthy(sign.scriptKey)) {
      delete this.talkNpc;
      interacted(this, fx, fy, "sign", sign);
      return this.vm.start(sign.scriptKey);
    }
    // BGEVENT_ITEM, the `.itemifset` arm of the same jumptable: a hidden item.
    // Its operand is `hiddenitem` data rather than a script, so the list is
    // built here. An item already taken has its flag set, and `.itemifset`
    // jumps to `.dontread` -- no carry, so the press falls through to the
    // tile events below exactly as if the bg event were not there.
    const hidden = HiddenItems.at(this.map ? this.map.def : undefined, fx, fy, this.events);
    if (truthy(hidden)) {
      delete this.talkNpc;
      // PlayTalkObject, the SFX every read of a bg event opens on.
      this.playSfxNamed("Sfx_ReadText2", SFX.READ_TEXT_2);
      interacted(this, fx, fy, "hidden", hidden);
      return this.vm.start(HiddenItems.pickupScript(hidden!.item, hidden!.event));
    }
    // CheckAPressOW's third and last try (engine/overworld/events.asm):
    // TryObjectEvent, then TryBGEvent, then TryTileCollisionEvent -- the
    // facing TILE's own events. TryTileCollisionEvent's order is fixed and
    // load bearing: CheckFacingTileForStdScript first, then cut tree,
    // whirlpool, waterfall, headbutt tree, and SURF last as the catch-all.
    //
    // CheckFacingTileForStdScript (engine/events/std_collision.asm): a facing
    // collision with a TileCollisionStdScripts row runs that std script. The
    // bodies come out of the cache's std_scripts table and run through the VM
    // like any map script -- PCScript is `opentext / special PokemonCenterPC /
    // closetext / end`.
    const coll = this.map ? this.map.cellCollision(fx, fy) : undefined;
    const std = coll != null ? TILE_COLLISION_STD_SCRIPTS[coll] : undefined;
    if (std) {
      const entry = this.stdScripts && this.stdScripts.scripts
        ? this.stdScripts.scripts[std] : undefined;
      if (entry && truthy(entry.key)) {
        delete this.talkNpc;
        interacted(this, fx, fy, "std", std);
        return this.vm.start(entry.key);
      }
    }
    if (truthy(this.tryCutOW())) {
      interacted(this, fx, fy, "fieldmove", "CUT");
      return true;
    }
    if (truthy(this.tryWhirlpoolOW())) {
      interacted(this, fx, fy, "fieldmove", "WHIRLPOOL");
      return true;
    }
    if (truthy(this.tryWaterfallOW())) {
      interacted(this, fx, fy, "fieldmove", "WATERFALL");
      return true;
    }
    if (truthy(this.tryHeadbuttOW(fx, fy))) {
      interacted(this, fx, fy, "fieldmove", "HEADBUTT");
      return true;
    }
    if (truthy(this.trySurfOW())) {
      interacted(this, fx, fy, "fieldmove", "SURF");
      return true;
    }
    interacted(this, fx, fy, "none");
    return false;
  }
  // ---- W6: World.lua:8684-9813 ----------------------------------------------

  // Lua: World.lua:8684-8687. Playfield.dimensions() is the Gold screen's
  // 160x144 here, so the fit is always 1.
  fitScale(): number {
    const w = 160;
    const h = 144;
    return Math.max(1, Math.floor(Math.min(w / 160, h / 144)));
  }

  // Lua: World.lua:8689-8691. Zoom is inert (no survey zoom on the 3DS):
  // Zoom.scale(fit) at offset 0 is the fit itself.
  zoomScale(): number {
    return this.fitScale();
  }

  // Lua: World.lua:8699-8727. Returns [atlas, tileset] (the Lua's two
  // values); atlas is a TileAtlasRef -- the roof overlay (applyRoofOverlay)
  // and the image load are the cook's, so only the identity is kept.
  atlasFor(mapDef: any): [TileAtlasRef | undefined, any] {
    const tileset = this.tilesets[mapDef.tileset];
    if (!truthy(tileset)) return [undefined, undefined];
    let cacheKey: string = mapDef.tileset;
    let roofName: any = undefined;
    if (ROOF_TILESETS[mapDef.tileset]) {
      roofName = this.roofs && this.roofs.mapGroupRoofs
        ? this.roofs.mapGroupRoofs[mapDef.group] : undefined;
    }
    if (truthy(roofName)) cacheKey = cacheKey + "|" + roofName;
    const cached = this.atlasCache[cacheKey];
    if (truthy(cached)) return [cached, tileset];

    const tilesPerRow = tileset.tilesPerRow ?? 16;
    const roofSpec = truthy(roofName) && this.roofs.roofs ? this.roofs.roofs[roofName] : undefined;
    const atlas: TileAtlasRef = { key: cacheKey, image: tileset.image, tilesPerRow };
    if (roofSpec && truthy(roofSpec.image)) atlas.roofImage = roofSpec.image;
    this.atlasCache[cacheKey] = atlas;
    return [atlas, tileset];
  }

  // Lua: World.lua:8729-8845 -- baked one map's 32px blocks into a canvas, a
  // GBC-accurate render: each tile's four colours from its PalMap slot in the
  // eight BG palettes LoadMapPals would load for this map's environment, time
  // of day and group. `daytime` is baked in (mapImages is keyed by map AND
  // daytime: a rollover re-bakes, like the cart reloading wBGPals1). The tile
  // painting is the voxel renderer's; what is kept is the palette SET the
  // bake resolved, including FlickeringCaveEntrancePalette's phase on a DARK
  // map (PAL_BG_YELLOW colour 0 from its own colour 0 or colour 1 -- both
  // phases are cached and World:pollCaveFlicker swaps between them).
  // Returns [image, bgSet] (the Lua's two values).
  bakeMapImage(map: any, daytime: any, flicker: any): [MapImageRef | undefined, any] {
    const [atlas, tileset] = this.atlasFor(map.def);
    if (!atlas || !truthy(tileset)) return [undefined, undefined];
    let bgSet: any = truthy(this.palettes) && truthy(daytime)
      ? Palettes.bgSet(this.palettes, map.def, daytime) : undefined;
    if (!truthy(bgSet)) bgSet = undefined;
    if (truthy(bgSet) && daytime === "DARK") {
      bgSet = Palettes.withCaveFlicker(bgSet, flicker ?? 1);
    }
    // Lua: World.lua:8778-8843 -- the clear colour (slot 0 colour 0, the
    // map's background wash) and the per-slot tile blits: drawing, replaced
    // by viewState() (the renderer reads bgSet).
    const image: MapImageRef = {
      mapId: map.def.id,
      key: this.mapCacheKey(map.def.id),
      daytime,
      flicker: flicker ?? 1,
      tileset: map.def.tileset,
      atlas: atlas.key,
    };
    return [image, bgSet];
  }

  // Lua: World.lua:8856-8890 -- every VRAM tile a tileset's program rewrites
  // and where each one's frames come from (engine/tilesets/tileset_anims.asm:
  // 167 water, :197 flower, :231 and :259 lava, :290 tower pillar, :350
  // whirlpool, plus the buffer scrolls at :65 and :139). Keyed by tile id.
  animLayers(tileset: any): Record<number, AnimLayer> | undefined {
    const anim = tileset ? tileset.anim : undefined;
    if (!(anim && anim.frames)) return undefined;
    const defs = this.tilesets;
    let wanted: Record<number, AnimLayer> | undefined = undefined;
    const add = (tile: any, layer: AnimLayer): void => {
      // A cache built before the strips were extracted has no sheet to draw
      // from, so that tile is left to the bake.
      if (tile == null || (layer.kind !== "scroll" && !truthy(layer.sheet))) return;
      wanted = wanted ?? {};
      wanted[tile] = layer;
    };
    for (const frame of anim.frames) {
      const func = frame.func;
      if (func === "AnimateWaterTile") {
        add(frame.tile,
          { kind: "water", sheet: defs ? defs.waterFrames : undefined, frames: 4 });
      } else if (func === "AnimateFlowerTile") {
        // AnimateFlowerTile takes no argument: it hardcodes vTiles2 tile $03
        // (engine/tilesets/tileset_anims.asm:222).
        add(0x03,
          { kind: "flower", sheet: defs ? defs.flowerFrames : undefined, frames: 4 });
      } else if (ANIM_KINDS[func]) {
        add(frame.tile, { kind: ANIM_KINDS[func]!, sheet: frame.sheet, frames: frame.frames });
      } else if (func === "WriteTileFromAnimBuffer" && truthy(frame.scroll)) {
        add(frame.tile, { kind: "scroll", scroll: frame.scroll, frames: 8 });
      }
    }
    return wanted;
  }

  // Lua: World.lua:8892-8933 -- the cells a tileset's anim program repaints,
  // gathered once per bake and keyed by tile id: the frames _AnimateTileset
  // would have written into VRAM, for the renderer to draw over the map.
  animCellsFor(map: any, tileset: any): Record<number, AnimCellList> | undefined {
    const wanted = this.animLayers(tileset);
    if (!wanted) return undefined;
    const blocks = tileset.blocks;
    const tilePalettes = tileset.tilePalettes;
    const crystal = truthy(this.isCrystal());
    let out: Record<number, AnimCellList> | undefined = undefined;
    for (let by = 0; by <= map.height - 1; by++) {
      for (let bx = 0; bx <= map.width - 1; bx++) {
        const blockId = BorderFill.blockFor(map.blocks[by * map.width + bx], map.borderBlock);
        const block = blocks ? blocks[blockId ?? 0] : undefined;
        if (block) {
          for (let i = 0; i <= 15; i++) {
            const tile: number = block[i] ?? 0;
            const layer = wanted[tile];
            if (layer) {
              out = out ?? {};
              let list = out[tile];
              if (!list) {
                list = {
                  layer,
                  tile,
                  slot: crystal ? TileAttrs.paletteSlot(tileset, tile)
                    : ((tilePalettes ? tilePalettes[tile] : undefined) ?? 1),
                  cells: [],
                };
                out[tile] = list;
              }
              const cells = list.cells;
              cells.push(bx * 32 + (i % 4) * 8);
              cells.push(by * 32 + Math.floor(i / 4) * 8);
            }
          }
        }
      }
    }
    return out;
  }

  // Lua: World.lua:8935-8943 -- the key imageFor caches a map's bake under,
  // shared with the anim cell lists and the palettes so the draw pass can
  // find them from a map id alone.
  mapCacheKey(mapId: string): string {
    const daytime = this.daytime;
    const flicker = (daytime === "DARK") ? (this.flickerPhase ?? 1) : 1;
    return mapId + "|" + tostring(daytime)
      + "|" + tostring(GbcPalette.mode) + "|" + tostring(GbcPalette.customRamp)
      + "|" + tostring(flicker);
  }

  // Lua: World.lua:8945-8969. The COLOR mode and the cave flicker phase are
  // in the key alongside the daytime (a dark map has two bakes). Returns the
  // MapImageRef (callers store it as self.mapImage / nb.image and test it).
  imageFor(mapId: string): MapImageRef | undefined {
    const daytime = this.daytime;
    const flicker = (daytime === "DARK") ? (this.flickerPhase ?? 1) : 1;
    const cacheKey = this.mapCacheKey(mapId);
    const cached = this.mapImages[cacheKey];
    if (truthy(cached)) return cached;
    const def = this.maps[mapId];
    if (!truthy(def)) return undefined;
    const tileset = this.tilesets[def.tileset];
    if (!truthy(tileset)) return undefined;
    const map = Map.new(def, tileset);
    const [img, bgSet] = this.bakeMapImage(map, daytime, flicker);
    if (img !== undefined) this.mapImages[cacheKey] = img;
    else delete this.mapImages[cacheKey];
    // Under the same key as the bake: the overlay needs both the cell list and
    // the palettes the bake resolved.
    this.animCells[cacheKey] = this.animCellsFor(map, tileset) ?? false;
    this.bgSets[cacheKey] = bgSet ?? false;
    return img;
  }

  // Lua: World.lua:8971-8978 -- SetTallGrassFlags' own test
  // (engine/overworld/map_objects.asm:247): CheckSuperTallGrassTile first,
  // then CheckGrassTile.
  grassAt(cx: number, cy: number): boolean {
    const map = this.map;
    if (!truthy(map)) return false;
    const coll = map.cellCollision(cx, cy);
    return Permissions.isSuperTallGrass(coll) || Permissions.isGrass(coll);
  }

  // Lua: World.lua:8980-9007 -- the tileset atlas with BG colour 0 keyed to
  // alpha (the grass redraw over a sprite's feet shows the legs through it).
  // The keyed image is the renderer's; this keeps the key. Returns
  // [atlasKey | undefined, tileset | undefined].
  grassAtlasFor(mapDef: any): [string | undefined, any] {
    const tileset = this.tilesets ? this.tilesets[mapDef ? mapDef.tileset : undefined] : undefined;
    if (!(tileset && truthy(tileset.image))) return [undefined, undefined];
    this.grassAtlases = this.grassAtlases ?? {};
    const cached = this.grassAtlases[tileset.image];
    if (cached !== undefined) return [cached || undefined, tileset];
    const made: string | false = tileset.image;
    this.grassAtlases[tileset.image] = made;
    return [made || undefined, tileset];
  }

  // Lua: World.lua:9009-9019 -- the 8x8 BG tile at a map pixel, through
  // LoadMetatiles' border-block rule.
  bgTileAt(map: any, tileset: any, mx: number, my: number): number | undefined {
    const bx = Math.floor(mx / 32);
    const by = Math.floor(my / 32);
    if (bx < 0 || by < 0 || bx >= map.width || by >= map.height) return undefined;
    const blockId = BorderFill.blockFor(map.blocks[by * map.width + bx], map.borderBlock);
    const block = tileset.blocks ? tileset.blocks[blockId ?? 0] : undefined;
    if (!block) return undefined;
    const i = Math.floor(mod(my, 32) / 8) * 4 + Math.floor(mod(mx, 32) / 8);
    return block[i];
  }

  // Lua: World.lua:9021-9036
  rebuildAttrGrid(): void {
    if (!truthy(this.isCrystal())) {
      this.attrGrid = undefined;
      return;
    }
    if (!truthy(this.map)) {
      this.attrGrid = undefined;
      return;
    }
    const [, tileset] = this.atlasFor(this.map.def);
    if (!truthy(tileset)) {
      this.attrGrid = undefined;
      return;
    }
    this.attrGrid = MapAttrGrid.build(this.map, tileset);
  }

  // Lua: World.lua:9038-9045
  bgTileAttrAt(map: any, tileset: any, mx: number, my: number): any {
    const cell = this.attrGrid ? MapAttrGrid.lookup(this.attrGrid, mx, my) : undefined;
    if (cell) return cell;
    const tile = this.bgTileAt(map, tileset, mx, my);
    if (tile == null) return undefined;
    const [tileId, attr] = MapAttrGrid.normalizeTile(tile, tileset);
    return { tileId, rawTileId: tile, attr };
  }

  // Lua: World.lua:9070-9085 feetCompositeCanvas, :9087-9157
  // blitBgOverRegionLocal: drawing, replaced by viewState().

  // Lua: World.lua:9159-9169 -- whether (tx, ty) is repainted by this map's
  // tileset anim program. (pairs order is free: a cell belongs to one tile.)
  animListAt(animCells: any, tx: number, ty: number): AnimCellList | undefined {
    if (!truthy(animCells)) return undefined;
    for (const k of Object.keys(animCells)) {
      const list: AnimCellList = animCells[k];
      const xy = list.cells;
      for (let i = 0; i < xy.length; i += 2) {
        if (xy[i] === tx && xy[i + 1] === ty) return list;
      }
    }
    return undefined;
  }

  // Lua: World.lua:9171-9201 blitBgOverRegion, :9203-9231 drawFeetComposite,
  // :9233-9275 drawGrassOverGoldSilver, :9277-9283 drawGrassOverCrystal,
  // :9285-9291 drawGrassOver, :9293-9299 drawBgPriorityOver, :9301-9307
  // drawPriorityOver, :9309-9342 drawGrassShake, :9344-9366 drawJumpShadow:
  // drawing, replaced by viewState() (WorldActorEntry.grassOver /
  // grassShake / jumpShadow carry what they decided).

  // Lua: World.lua:9368-9402 -- this frame's AnimateWaterTile graphic for a
  // map's border block, or undefined when the block holds no water at all
  // (engine/tilesets/tileset_anims.asm:167). `row` is 1-based.
  borderWaterFrame(def: any, tileset: any): BorderWaterFrame | undefined {
    const anim = tileset ? tileset.anim : undefined;
    if (!(anim && anim.frames)) return undefined;
    let tile: number | undefined;
    for (const frame of anim.frames) {
      if (frame.func === "AnimateWaterTile" && frame.tile != null) {
        tile = frame.tile;
        break;
      }
    }
    if (tile == null) return undefined;
    const fill = BorderFill.fillBlock(def);
    if (fill === false) return undefined;
    const block = tileset.blocks ? tileset.blocks[BorderFill.blockFor(0, fill)] : undefined;
    if (!block) return undefined;
    let found = false;
    for (let i = 0; i < 16; i++) {
      if (block[i] === tile) {
        found = true;
        break;
      }
    }
    if (!found) return undefined;
    const sheets = this.animSheets();
    if (!(sheets && sheets.water)) return undefined;
    return {
      image: sheets.water,
      row: World.waterFrameFor(this.animTimer),
      tile,
      slot: (tileset.tilePalettes ? tileset.tilePalettes[tile] : undefined) ?? 1,
    };
  }

  // Lua: World.lua:9404-9446 -- the 32x32 border-block bake for a map, cached
  // under the same key its canvas is (plus BorderFill's suffix) so the
  // daytime rollover, the COLOR option, the flicker phase and
  // World:dropMapImages' prefix sweep all reach it. The palettes are the
  // map's own. BorderFill.bake is the renderer's (it is a no-op here), so
  // the cached value is a BorderImageRef: the key plus what the bake used.
  borderImageFor(mapId: string): BorderImageRef | undefined {
    const daytime = this.daytime;
    const flicker = (daytime === "DARK") ? (this.flickerPhase ?? 1) : 1;
    const def = this.maps ? this.maps[mapId] : undefined;
    if (!truthy(def)) return undefined;
    const tileset = this.tilesets ? this.tilesets[def.tileset] : undefined;
    if (!truthy(tileset)) return undefined;
    // VOID FILL black skips the tiled bake; the renderer paints a flat void.
    const fill = BorderFill.fillBlock(def);
    if (fill === false) return undefined;
    const blockId = BorderFill.blockFor(0, fill);
    // A water border block animates with the rest of the map, so this
    // frame's row joins the key; the VOID FILL mode is in the key so
    // switching FADE/WATER/TREES does not keep a stale bake (#1418).
    const waterFrame = this.borderWaterFrame(def, tileset);
    const cacheKey = BorderFill.cacheKey(mapId + "|" + tostring(daytime)
      + "|" + tostring(GbcPalette.mode) + "|" + tostring(GbcPalette.customRamp)
      + "|" + tostring(flicker)
      + "|" + tostring(BorderFill.voidFill ?? "fade")
      + "|" + tostring(blockId)
      + "|" + tostring(waterFrame ? waterFrame.row : 0));
    const cached = this.mapImages[cacheKey];
    if (cached !== undefined) return cached || undefined;
    const [atlas] = this.atlasFor(def);
    if (!atlas) return undefined;
    let bgSet: any = truthy(this.palettes) && truthy(daytime)
      ? Palettes.bgSet(this.palettes, def, daytime) : undefined;
    if (!truthy(bgSet)) bgSet = undefined;
    if (truthy(bgSet) && daytime === "DARK") {
      bgSet = Palettes.withCaveFlicker(bgSet, flicker ?? 1);
    }
    const img: BorderImageRef = { key: cacheKey, mapId, blockId, atlas: atlas.key, bgSet, waterFrame };
    this.mapImages[cacheKey] = img;
    return img;
  }

  // Lua: World.lua:9448-9463 -- FlickeringCaveEntrancePalette runs on the
  // VBlank clock, so this runs on the fixed step: two frames on, two off,
  // only on a DARKNESS_PALSET map. A phase change swaps the cached image
  // reference rather than re-baking.
  pollCaveFlicker(): boolean {
    if (this.daytime !== "DARK" || !truthy(this.mapImage)) return false;
    this.flickerClock = mod(this.flickerClock + 1, Palettes.FLICKER_PERIOD);
    const phase = Palettes.caveFlickerSource(this.flickerClock);
    if (phase === this.flickerPhase) return false;
    this.flickerPhase = phase;
    this.mapImage = this.imageFor(this.map.id);
    for (const nb of seq_W6(this.neighbors)) {
      nb.image = this.imageFor(nb.id) ?? nb.image;
    }
    return true;
  }

  // Lua: World.lua:9465-9470 -- `wTileAnimationTimer and %110`
  // (tileset_anims.asm:172-174): four water frames, each held for two ticks
  // of the 0..7 timer. 1-based, as the Lua indexes the sheet's four rows.
  static waterFrameFor(timer: any): number {
    return Math.floor(mod(timer ?? 0, 8) / 2) + 1;
  }

  // Lua: World.lua:9472-9479 -- AnimateFlowerTile's `and %10` plus hCGB
  // (tileset_anims.asm:204-212): on CGB only cgb_1 and cgb_2 are ever
  // written, alternating every two timer ticks. (1-based rows.)
  flowerFrameFor(timer: any): number {
    const rows = this.tilesets ? this.tilesets.flowerCgbFrames : undefined;
    let first = 2;
    let second = 4;
    if (rows && rows[0] != null && rows[1] != null) {
      first = rows[0];
      second = rows[1];
    }
    return (mod(timer ?? 0, 4) < 2) ? first : second;
  }

  // Lua: World.lua:9481-9495 -- _AnimateTileset (tileset_anims.asm:11) runs
  // ONE row of the tileset's program per frame and DoneTileAnimation (:48)
  // wraps the index, so a pass is `period` frames; StandingTileFrame8 (:57)
  // ticks the 0..7 timer once per pass.
  pollTileAnim(): boolean {
    const tileset = this.map && this.map.def && this.tilesets
      ? this.tilesets[this.map.def.tileset] : undefined;
    const anim = tileset ? tileset.anim : undefined;
    if (!(anim && anim.period && anim.period > 0)) return false;
    this.animClock = (this.animClock ?? 0) + 1;
    if (this.animClock < anim.period) return false;
    this.animClock = 0;
    this.animTimer = mod((this.animTimer ?? 0) + 1, 8);
    return true;
  }

  // Lua: World.lua:9501-9515 -- which row (1-based) of a layer's strip this
  // timer value shows. Whirlpool `and %11` (tileset_anims.asm:368); lava
  // `and %110` halved, with tile $5b running two frames ahead of tile $38
  // (:238-245, :266-270).
  animRow(layer: AnimLayer): number {
    const timer = mod(this.animTimer ?? 0, 8);
    const kind = layer.kind;
    if (kind === "water") return World.waterFrameFor(timer);
    if (kind === "flower") return this.flowerFrameFor(timer);
    if (kind === "whirlpool") return (timer % 4) + 1;
    if (kind === "tower") return TOWER_ROWS[timer]!;
    if (kind === "lava2") return Math.floor(timer / 2) + 1;
    if (kind === "lava1") return ((Math.floor(timer / 2) + 2) % 4) + 1;
    // A scroll strip is baked one row per timer value.
    return timer + 1;
  }

  // Lua: World.lua:9517-9528 -- one frame strip, "loaded" once: the gfx key
  // is what the renderer draws with, so the key is the cached value.
  animSheet(path: any): string | undefined {
    if (!truthy(path)) return undefined;
    this.animSheetPaths = this.animSheetPaths ?? {};
    const cached = this.animSheetPaths[path];
    if (cached !== undefined) return cached || undefined;
    this.animSheetPaths[path] = path;
    return path;
  }

  // Lua: World.lua:9530-9546 -- the two strips the border-block bake reaches
  // for by name, memoized as a pair (gfx keys).
  animSheets(): { water?: string; flower?: string } | undefined {
    if (this.animSheetCache !== undefined) return this.animSheetCache || undefined;
    const defs = this.tilesets;
    let sheets: { water?: string; flower?: string } | undefined = undefined;
    const paths: Record<string, any> = {
      water: defs ? defs.waterFrames : undefined,
      flower: defs ? defs.flowerFrames : undefined,
    };
    for (const kind of ["water", "flower"] as const) {
      const img = this.animSheet(paths[kind]);
      if (img) {
        sheets = sheets ?? {};
        sheets[kind] = img;
      }
    }
    this.animSheetCache = sheets ?? false;
    return sheets;
  }

  // Lua: World.lua:9553-9601 -- one scroll tile's eight positions, which the
  // Lua baked into an 8x64 strip off the atlas. The rotation itself is
  // scrollTileOffset() (W6 locals); this keeps the strip's identity, cached
  // under the Lua's key. Undefined when there is no atlas.
  scrollStrip(mapDef: any, tileset: any, tile: number, scroll: any): any {
    const key = tostring(mapDef.tileset) + "|" + tile + "|"
      + tostring(scroll.h) + "," + tostring(scroll.v);
    this.scrollStrips = this.scrollStrips ?? {};
    const cached = this.scrollStrips[key];
    if (cached !== undefined) return cached || undefined;
    const [atlas] = this.atlasFor(mapDef);
    if (!atlas) {
      this.scrollStrips[key] = false;
      return undefined;
    }
    const strip = {
      key, atlas: atlas.key, tile, scroll,
      tilesPerRow: tileset.tilesPerRow ?? 16,
    };
    this.scrollStrips[key] = strip;
    return strip;
  }

  // Lua: World.lua:9603-9614 animQuad, :9616-9668 drawAnimCells: drawing,
  // replaced by viewState() (WorldMapView.anim carries each list and row).

  // Lua: World.lua:9670-9700 -- one entity's OW palette. The group string
  // keeps one bake per (daytime, PAL_OW_*) pair, so two NPCs on the same
  // palette share it. entity.sprite is a SpriteHandle.
  applySpritePalette(entity: any): void {
    if (!(truthy(this.palettes) && entity && entity.sprite && entity.spriteDef)) {
      return;
    }
    const daytime = truthy(this.daytime) ? this.daytime
      : Palettes.daytimeFor(this.map ? this.map.def : undefined, this.hour(), this.flashUsed);
    // entity.def is the object_event, whose own palette field OVERRIDES the
    // sprite's (Palettes.objectPaletteId; AddMapObject, player_object.asm:187).
    let def = entity.def;
    if (entity === this.player) def = this.playerObjectDef();
    const colors = Palettes.spritePalette(this.palettes, daytime, entity.spriteDef, def);
    if (!truthy(colors)) return;
    // The bake cache key has to be the palette actually chosen, or the three
    // beasts -- one sheet, three object palettes -- would share the first.
    const id = Palettes.objectPaletteId(def) ?? entity.spriteDef.paletteId ?? 0;
    entity.sprite.setObjPalette(colors, format("gen2:%s:%d", tostring(daytime), id));
  }

  // Lua: World.lua:9708-9735 -- world.tod: what time of day the WORLD is in.
  // Gold has a real clock behind it, so this is the one write everything
  // downstream reads (VAR.TIMEOFDAY, encounter slots, object hour windows,
  // palettes). Gen 1's ctx keys are kept; `hour` and `weekday` are added.
  timeOfDay(hour: number): string {
    const clock = Palettes.clockDaytime(hour);
    if (!Runtime.wantsHook("world.tod")) return clock;
    const map = this.map;
    const p = this.player;
    const save = this.game ? this.game.save : undefined;
    const next_ = Runtime.call("world.tod", sameTod, clock, {
      map,
      mapId: map ? map.id : undefined,
      x: p ? p.cellX : undefined,
      y: p ? p.cellY : undefined,
      steps: (save && save.stepCount) || 0,
      hour,
      weekday: this.weekday(),
    });
    if (typeof next_ !== "string" || next_ === "") return clock;
    return next_;
  }

  // Lua: World.lua:9670-9675, :9737-9792 -- recompute the active time of day
  // and hand every drawable its colours; on map entry and once a second
  // while walking. Returns true when the daytime changed (the cached map
  // images are stale and callers drop them).
  applyPalettes(): boolean {
    if (!truthy(this.map)) return false;
    const previous = this.daytime;
    const previousTod = this.tod;
    // GetTimeOfDay reads hHours, the one clock UpdateTime writes: palette,
    // object hour windows, encounter slots and VAR.HOUR are the same read.
    const hour = this.hour();
    const tod = this.timeOfDay(hour);
    this.tod = tod;
    // ReplaceTimeOfDayPals.BrightnessLevels: a map header that pins a
    // PALETTE_* overrides the clock, and PALETTE_DARK becomes NITE once FLASH
    // is used. Only clock-following maps take the hooked answer.
    const def = this.map.def;
    const pinned = truthy(def) && truthy(def.palette) && def.palette !== "PALETTE_AUTO";
    let daytime: any = tod;
    if (pinned) {
      const forced = Palettes.daytimeFor(def, hour, this.flashUsed);
      if (truthy(forced)) daytime = forced;
    }
    // map.palette: which four-colour set a map loads is named by its DAYTIME.
    if (Runtime.wantsHook("map.palette")) {
      const hooked = Runtime.call("map.palette", samePalette, daytime, this.map,
        { tod, environment: truthy(def) ? def.environment : undefined,
          pinned: pinned ? def.palette : undefined, hour,
          flashUsed: truthy(this.flashUsed) });
      if (typeof hooked === "string" && Palettes.DAYTIME_ID[hooked]) {
        daytime = hooked;
      }
    }
    this.daytime = daytime;
    const changed = previous !== this.daytime;

    // Gen 1 fires world.tod_changed off the same transition; `daytime` is the
    // addition.
    if (previousTod != null && previousTod !== tod
        && Runtime.wants("world.tod_changed")) {
      Runtime.emit("world.tod_changed", {
        tod, previous: previousTod, mapId: this.map.id,
        daytime: this.daytime,
      });
    }

    if (truthy(this.palettes)) {
      this.applySpritePalette(this.player);
      const pool = this.npcPool ?? {};
      for (const k of sortedKeys(pool)) this.applySpritePalette(pool[k]);
    }
    return changed;
  }

  // Lua: World.lua:9794-9812. The view is the Gold screen's 160x144 at scale
  // 1 (Zoom inert), so viewW/viewH are 160/144.
  rebuildNeighbors(): void {
    this.neighbors = [];
    if (!truthy(this.map)) return;
    const s = this.zoomScale();
    const ww = 160;
    const wh = 144;
    let vw = Math.ceil(ww / s);
    let vh = Math.ceil(wh / s);
    if (vw % 2 !== 0) vw = vw + 1;
    if (vh % 2 !== 0) vh = vh + 1;
    this.viewW = vw;
    this.viewH = vh;
    const list = World.computeNeighbors(this.maps, this.map.id, NEIGHBOR_HOPS, vw, vh);
    for (const n of list) {
      const img = this.imageFor(n.id);
      if (img) {
        this.neighbors.push({ id: n.id, ox: n.ox, oy: n.oy, image: img });
      }
    }
  }

  // ---- W6: World.lua:11209-11825 --------------------------------------------

  // Lua: World.lua:11209-11213 -- DoPlayerMovement .GetDPad: a DOWNHILL map
  // with no direction held reads as DOWN (the Cycling Road rolling the
  // player along on its own).
  pollInput(input: any): void {
    this.heldDir = Bike.forcedDirection(heldDirection(input), this.downhill());
  }

  // Lua: World.lua:11215-11219. Zoom.step is inert (no survey zoom); the
  // rebuild it triggered is kept.
  zoomStep(_delta?: number): void {
    this.rebuildNeighbors();
    this.rebuildPeople({ seamless: true });
  }

  // Lua: World.lua:11221-11225. Zoom.cycle is inert; the rebuild is kept.
  zoomCycle(): void {
    this.rebuildNeighbors();
    this.rebuildPeople({ seamless: true });
  }

  // Lua: World.lua:11227-11277 drawGround, :11279-11309
  // drawEntityComposite, :11311-11386 drawPeople, :11388-11429 drawEmote,
  // :11431-11435 drawWorldBody, :11437-11487 drawPipeline, :11489-11498
  // tiltMesh, :11500-11564 drawTilted: drawing, replaced by viewState().
  // BorderFill.draw's crossfade bookkeeping moved to updateView().

  // Lua: World.lua:11566-11578 -- the COLOR option can change under a
  // standing world, and the map image is a cached reference keyed by it, so
  // the references are re-fetched when it does. (The Lua ran this at the top
  // of World:draw; here updateView() does.)
  refreshColorMode(): void {
    const mode = GbcPalette.mode;
    const ramp = GbcPalette.customRamp;
    if (this.colorMode === mode && this.colorRamp === ramp) return;
    this.colorMode = mode;
    this.colorRamp = ramp;
    if (!truthy(this.map)) return;
    this.mapImage = this.imageFor(this.map.id);
    this.rebuildNeighbors();
  }

  // Lua: World.lua:11580-11642 drawFadeRemap: drawing (the BGP remap shader
  // pass), replaced by viewState().fade (mode "remap" with the ramp row).

  /**
   * Lua: World.lua:11644-11813 (World:draw). The voxel world is drawn by
   * platform/worldview.ts from viewState(), and the Gold-screen half (map
   * name sign, pokepic window) by drawOverlay(), so this paints nothing. It
   * stays because callers (Game2, screens that draw the world under them)
   * call world:draw(). Its state work lives in updateView(): the COLOR
   * refresh, the camera follow with the earthquake offset, the border
   * crossfade and the poison flash countdown. The "No map." title card,
   * TILT, world pipelines and the POKEPORT_DEV survey HUD are desktop-only
   * and are not ported.
   */
  draw(): void {}

  /**
   * The render-frame state World:draw advanced (Lua: World.lua:11647,
   * :11664-11700, :11258 via BorderFill.draw, :11767-11768). Called by
   * viewState(), once per rendered frame, as the Lua's draw ran once per
   * frame. It touches only render-side state: the cached image references
   * (refreshColorMode), the camera, BorderFill's crossfade bookkeeping and
   * the poison-flash countdown only the draw ever consumed. Returns what the
   * frame shows for the last two.
   */
  updateView(): { border: WorldBorderView | undefined; poisonOn: boolean } {
    this.refreshColorMode();
    if (!truthy(this.mapImage) || !truthy(this.player)) {
      return { border: undefined, poisonOn: false };
    }
    // Lua: World.lua:11664-11683 -- the view size (no pipeline, no tilt:
    // 160x144 at scale 1). rebuildNeighbors always leaves viewW/viewH at the
    // same size, so the rebuild branch only runs on a world that never set
    // a map up through it.
    const s = this.zoomScale();
    let vw = Math.ceil(160 / s);
    let vh = Math.ceil(144 / s);
    if (vw % 2 !== 0) vw = vw + 1;
    if (vh % 2 !== 0) vh = vh + 1;
    if (vw !== this.viewW || vh !== this.viewH) {
      this.rebuildNeighbors();
      this.rebuildPeople({ seamless: true });
    }
    this.viewW = vw;
    this.viewH = vh;

    // Lua: World.lua:11685-11700
    const p = this.player;
    this.camera.follow(p.px, p.py, vw, vh);
    // StepFunction_ScreenShake adds its offset to wPlayerStepVectorY: the
    // whole frame slides vertically while the ground stays put underneath.
    if (this.shake) {
      this.camera.y = this.camera.y + (this.shake.phase ?? 0);
    }
    // ScreenPosition's lift (a desktop window-layout nudge) is 0 here.

    // Lua: World.lua:11239-11261 (drawGround) -> BorderFill.draw's
    // crossfade, which only runs when there is a border image to draw.
    let border: WorldBorderView | undefined = undefined;
    if (truthy(this.map)) {
      const def = this.map.def;
      const fillBlock = BorderFill.fillBlock(def);
      const fillKey = BorderFill.fillKey(def);
      if (fillBlock === false) {
        border = { fillBlock, fillKey, image: undefined, crossfadeFrom: undefined, crossfadeAlpha: 1 };
      } else {
        const image = this.borderImageFor(this.map.id);
        let from: unknown = undefined;
        let alpha = 1;
        if (image) [from, alpha] = BorderFill.crossfade(this, image, fillKey);
        border = { fillBlock, fillKey, image, crossfadeFrom: from, crossfadeAlpha: alpha };
      }
    }

    // Lua: World.lua:11766-11768 -- engine/events/poisonstep_pals.asm:9-42:
    // four drawn frames of the flash.
    let poisonOn = false;
    if (this.poisonFlash && this.poisonFlash > 0) {
      this.poisonFlash = this.poisonFlash - 1;
      poisonOn = true;
    }
    return { border, poisonOn };
  }

  /**
   * World:viewState() -- NEW (no Lua counterpart): everything a renderer
   * needs this frame, gathered from the state World:draw and its helpers
   * (drawGround, drawAnimCells, drawPeople, drawEntityComposite,
   * drawGrassShake, drawJumpShadow, drawGrassOver, drawEmote, drawHealAnim,
   * drawFlyAnim/drawFlyLeaves, drawFadeRemap, MapNameSign.draw) read. Call
   * it ONCE per rendered frame: it first runs updateView() (camera follow +
   * earthquake offset, COLOR refresh, border crossfade, poison-flash
   * countdown -- the render-side work the Lua's draw did). It changes no
   * game logic state. Coordinates are map pixels of the CURRENT map unless
   * noted (ActorView px/py are local to the actor's own map; add ox/oy).
   *
   * WorldView
   *   ready        false before a map image and a player exist (the Lua's
   *                "No map." card); every other field may then be empty.
   *   status       self.status (load failure text), when set.
   *   isCrystal    Crystal rules (attrmap BG_PRIO, grass-over on ghosts).
   *   map          WorldMapView: id, name (landmarkName), group, number
   *                (map header group/map), tileset, environment, palette
   *                (PALETTE_*), width/height (blocks), borderBlock, image
   *                (MapImageRef: the cache key the bake is under), bgSet
   *                (resolved BG palette set incl. cave flicker; Lua slot n
   *                at [n-1]), anim (WorldAnimCells[]: per animated tile id
   *                its layer {kind, sheet gfx key, frames, scroll}, PalMap
   *                slot, flat cell list x0,y0,x1,y1.., this frame's 1-based
   *                strip row, and scrollOffset [dx,dy] for scroll layers).
   *   neighbors    WorldNeighborView[]: id, ox, oy (pixel offset from the
   *                current map), image, bgSet, anim -- the connection
   *                strips World.computeNeighbors placed, drawn under the map.
   *   border       WorldBorderView: fillBlock (metatile, or false = flat
   *                black void), fillKey, image (BorderImageRef: blockId,
   *                bgSet, waterFrame {image, row, tile, slot}),
   *                crossfadeFrom / crossfadeAlpha (BorderFill's dissolve).
   *   camera       x, y: the view's top-left in map pixels after
   *                Camera:follow(player.px, player.py) plus the earthquake
   *                offset; viewW/viewH (160x144).
   *   shakeY       the earthquake offset already added to camera.y.
   *   player       view (Player:viewState()), visible (drawn this frame:
   *                not flyHides / playerMasked / playerHidden / peopleHidden,
   *                and the view's own visible), moving, jumping, state
   *                (FieldMoves.PLAYER_* -- normal/bike/surf), stateId
   *                (wPlayerState byte), inGrass.
   *   actors       WorldActorEntry[] in draw order (Y-sorted, player
   *                included): kind, view (ActorView), ox/oy (actor's map
   *                offset; neighbour ghosts carry theirs), onMap, mapId,
   *                npcIndex (into world.npcs, -1 otherwise), grassOver
   *                (tall-grass redraw over the feet), grassShake
   *                ({gfx, paletteId 6, two tiles}), jumpShadow ({gfx,
   *                paletteId 5, two tiles}). Empty when flyHides or
   *                peopleHidden.
   *   peopleHidden / hideAll / hidePlayer / playerMasked / playerHidden
   *                the flags that gated the list.
   *   skyfall      {phase, timer, height} while the pit fall runs.
   *   emote        {gfx, name, target, npcIndex, x, y (16x16 bubble
   *                top-left: entity px, py - 16), framesLeft, paletteId 5}.
   *   fishing      {phase cast/bite/done, timer, facing, bobber}; the rod
   *                itself is the player view's extra.fishing.
   *   headbutt     {x, y (cell), timer} while the tree shake runs (the frame
   *                shake is in shakeY).
   *   heal         HealMachineView: gfx, palette, hof, phase, lights and
   *                balls (PlacedTile, map pixels), rotation, remapByte.
   *   fly          FlyAnimView: phase, preroll, icon, bird {x, y, beat,
   *                frame, mirror} and leaves [{x, y}] in GB-SCREEN pixels
   *                (not map pixels), leafGfx, leafPaletteId 6.
   *   flyHidden    "from" / "to" while the fly warp hides the player.
   *   fieldMove    the running field-move tail's phase, if any.
   *   fade         FadeView: color, level (0..1), hold, whiten, mode
   *                ("remap" = BGP ramp `row`/`byte` over world and sprites;
   *                "sheet" = flat colour at `level` alpha over the world).
   *   poisonFlash  {rgba} on the frames the poison-step flash shows.
   *   palette      daytime (palette set: MORN/DAY/NITE/DARK), tod, timeOfDayId
   *                (VAR_TIMEOFDAY), colorMode (GbcPalette.mode), flashUsed,
   *                dark (DARKNESS palset loaded), flickerPhase (1/2) and
   *                flickerClock of the cave-entrance flicker.
   *   tileAnim     clock (frames into the anim pass), timer (0..7).
   *   mapSign      {shown, timer, name} (Crystal's map name sign).
   *   ui           textbox, choicebox, pokePic, script (VM running),
   *                moveState, mapSetup, busy (World:busy), battleActive.
   */
  viewState(): WorldView {
    const frame = this.updateView();
    const p = this.player;
    const map = this.map;
    const ready = truthy(this.mapImage) && truthy(p);
    const crystal = truthy(this.isCrystal());

    const mapView: WorldMapView | undefined = truthy(map) ? {
      id: map.id,
      name: ready ? (this.landmarkName() ?? undefined) : undefined,
      group: map.def ? map.def.group : undefined,
      number: map.def ? map.def.map : undefined,
      tileset: map.def ? map.def.tileset : undefined,
      environment: map.def ? map.def.environment : undefined,
      palette: map.def ? map.def.palette : undefined,
      width: map.width,
      height: map.height,
      borderBlock: map.borderBlock,
      image: this.mapImage || undefined,
      bgSet: this.bgSets[this.mapCacheKey(map.id)] || undefined,
      anim: animView_W6(this, this.mapCacheKey(map.id)),
    } : undefined;

    const neighbors: WorldNeighborView[] = [];
    for (const nb of seq_W6(this.neighbors)) {
      const key = this.mapCacheKey(nb.id);
      neighbors.push({
        id: nb.id, ox: nb.ox, oy: nb.oy, image: nb.image,
        bgSet: this.bgSets[key] || undefined,
        anim: animView_W6(this, key),
      });
    }

    // Lua: World.lua:11315 -- World:flyHides returns [hideAll, hidePlayer].
    const [hideAll, hidePlayer]: [boolean, boolean] = this.flyHides();
    const peopleHidden = truthy(this.peopleHidden);
    const actors: WorldActorEntry[] = [];
    if (ready && !peopleHidden) peopleView_W6(this, actors, hideAll, hidePlayer, crystal);

    let playerView: WorldView["player"] = undefined;
    if (truthy(p)) {
      const view = p.viewState();
      playerView = {
        view,
        visible: ready && !peopleHidden && !hideAll && !hidePlayer
          && !truthy(this.playerMasked) && !truthy(this.playerHidden) && view.visible,
        moving: truthy(p.moving),
        jumping: truthy(p.jumping),
        state: this.playerState,
        stateId: this.playerState != null ? PLAYER_STATE_ID[this.playerState] : undefined,
        inGrass: truthy(p.inGrass),
      };
    }

    const fx = ready && !peopleHidden;
    return {
      ready,
      status: this.status ?? undefined,
      isCrystal: crystal,
      map: mapView,
      neighbors,
      border: frame.border,
      camera: { x: this.camera.x, y: this.camera.y, viewW: this.viewW ?? 160, viewH: this.viewH ?? 144 },
      shakeY: this.shake ? (this.shake.phase ?? 0) : 0,
      player: playerView,
      actors,
      peopleHidden,
      hideAll,
      hidePlayer,
      playerMasked: truthy(this.playerMasked),
      playerHidden: truthy(this.playerHidden),
      skyfall: this.skyfall
        ? { phase: this.skyfall.phase, timer: this.skyfall.timer, height: this.skyfall.height }
        : undefined,
      emote: fx ? emoteView_W6(this) : undefined,
      fishing: this.fishing
        ? { phase: this.fishing.phase, timer: this.fishing.timer, facing: this.fishing.facing,
            bobber: this.fishing.bobber }
        : undefined,
      headbutt: this.headbutt
        ? { x: this.headbutt.x, y: this.headbutt.y, timer: this.headbutt.timer }
        : undefined,
      heal: fx ? healView_W6(this) : undefined,
      fly: fx ? flyView_W6(this) : undefined,
      flyHidden: this.flyHidden ?? undefined,
      fieldMove: this.fieldMove ? this.fieldMove.phase : undefined,
      fade: fadeView_W6(this),
      // Lua: World.lua:11769-11773
      poisonFlash: frame.poisonOn
        ? { rgba: GbcPalette.mode === "gbc" ? [28 / 31, 21 / 31, 1, 0.55] : [0, 0, 0, 0.45] }
        : undefined,
      palette: {
        daytime: this.daytime ?? undefined,
        tod: this.tod ?? undefined,
        timeOfDayId: truthy(map) ? this.timeOfDayId() : undefined,
        colorMode: GbcPalette.mode,
        flashUsed: truthy(this.flashUsed),
        dark: this.daytime === "DARK",
        flickerPhase: this.flickerPhase ?? 1,
        flickerClock: this.flickerClock ?? 0,
      },
      tileAnim: { clock: this.animClock ?? 0, timer: this.animTimer ?? 0 },
      mapSign: this.mapSign
        ? { shown: truthy(this.mapSign.shown), timer: this.mapSign.timer, name: this.mapSign.name }
        : undefined,
      ui: {
        textbox: this.textbox != null,
        choicebox: this.choicebox != null,
        pokePic: truthy(this.pokePic),
        script: this.runner ? truthy(this.runner.isRunning()) : false,
        moveState: this.moveState != null,
        mapSetup: this.mapSetup != null,
        busy: truthy(this.busy()),
        battleActive: truthy(this.battleActive),
      },
    };
  }

  /**
   * Lua: World.lua:11723-11764 -- the Gold-screen half of World:draw: the map
   * name sign (Crystal only; MapNameSign.draw returns at once on Gold) and
   * the pokepic window (engine/events/pokepic.asm:1-28: MenuBox at the
   * header's coords, then the padded 7x7 frontpic at top+1, left+1). Game2
   * calls it while the world is the base layer, over the voxel scene. The
   * UI-layer canvas swap and the fit-scale centring have nothing to do on
   * the Gold screen (it IS the 160x144 panel).
   */
  drawOverlay(): void {
    const w = 160;
    const h = 144;
    // ../pokecrystal/engine/events/map_name_sign.asm:114
    MapNameSign.draw(this, w, h, 0);
    if (this.pokePic) {
      const [pw] = this.pokePic.getDimensions();
      const pad = POKEPIC.pad[Math.floor(pw / 8)] ?? POKEPIC.pad[7]!;
      G.push();
      G.setColor(1, 1, 1, 1);
      const raw = truthy(this.pokePicTrueColor) && GbcPalette.mode === "gbc";
      const pic = (): void => {
        G.draw(this.pokePic, (POKEPIC.left + 1 + pad[0]) * 8,
          (POKEPIC.top + 1 + pad[1]) * 8);
      };
      const body = (): void => {
        Font.drawBox(POKEPIC.left, POKEPIC.top, POKEPIC.w, POKEPIC.h);
        if (!raw) pic();
      };
      if (this.pokePicColors) {
        GbcPalette.with(this.pokePicColors, body);
      } else {
        body();
      }
      if (raw) pic();
      G.pop();
      G.setColor(1, 1, 1, 1);
    }
    // Lua: World.lua:11766-11812 -- the poison flash and the fade sheet are
    // world-layer overlays (viewState().poisonFlash / .fade); the survey HUD
    // is desktop-only.
  }

  // ---- W7: World.lua:9814-11208 -------------------------------------------

  // Lua: World.lua:9814-10044
  setMap(mapId: any, cx: number, cy: number, facing?: any, opts?: any): boolean {
    opts = opts ?? {};
    const def = this.maps[mapId];
    if (!truthy(def)) {
      this.status = "Unknown map " + tostring(mapId);
      return false;
    }
    const tileset = this.tilesets[def.tileset];
    if (!truthy(tileset)) {
      this.status = "Missing tileset " + tostring(def.tileset);
      return false;
    }
    // map.exited / map.entered are the Gen 1 pair (src/world/
    // OverworldController setMap), same names and payload keys. Divergence,
    // deliberate: the exit is emitted BELOW the two guards above, because
    // Gold's setMap can refuse a load Gen 1's would have asserted on, and an
    // "exited" followed by no "entered" reads as a map that vanished.
    const fromMapId = this.map ? this.map.id : undefined;
    if (truthy(fromMapId)) {
      Runtime.emit("map.exited", { mapId: fromMapId, toMapId: mapId });
    }
    // LoadMapAttributes refills wOverworldMapBlocks from ROM, so every block
    // CUT and WHIRLPOOL swapped out goes back -- before Map.new reads them.
    this.restoreBlocks();
    this.restoreObjectSpawns();
    // HandleNewMap (home/map.asm:216-228) runs ResetMapBufferEventFlags first:
    // event flags 0-7 (EVENT_TEMPORARY_UNTIL_MAP_RELOAD) die on every map load,
    // re-arming every once-per-visit latch (Bill's grandpa, Kurt's house, the
    // ship ports, Dragon's Den B1F, the Park gate).
    //
    // MapSetupScript_Continue is the one entry that does NOT: HandleContinueMap
    // is the label BELOW that reset, so loading a save keeps the byte SRAM held
    // (data/maps/setup_scripts.asm) -- else saving inside Kurt's house and
    // continuing replays his branch. The post-credits spawn is MAPSETUP.WARP,
    // so it takes the reset (engine/menus/intro_menu.asm).
    if (!truthy(opts.continue)) {
      this.events.resetMapBuffer();
    }
    // ResetBikeFlags (home/flag.asm) zeroes the whole byte on a map load, and
    // BIKEFLAGS_STRENGTH_ACTIVE_F is in it -- the shape of the Blackthorn Gym
    // puzzle.
    this.strengthActive = false;
    this.strengthMon = undefined;
    // The other two bits of the same byte, cleared BEFORE MAPCALLBACK_NEWMAP,
    // because the Cycling Road's callback sets them straight back again.
    this.setEngineFlag(this.engineFlagId("ENGINE_ALWAYS_ON_BIKE", Bike.ENGINE_ALWAYS_ON_BIKE), false);
    this.setEngineFlag(this.engineFlagId("ENGINE_DOWNHILL", Bike.ENGINE_DOWNHILL), false);
    // "Respawn in Pokemon Centers" (home/map.asm, LoadMapAttributes'
    // .SetSpawn): walking from an OUTDOOR map into an INDOOR TILESET_POKECENTER
    // one rewrites wLastSpawnMapGroup / wLastSpawnMapNumber, the pair a
    // whiteout reads -- on the map load, whether or not you talk to the nurse.
    // (Without it MrPokemonsHouse's `blackoutmod CHERRYGROVE_CITY` pinned the
    // respawn to Cherrygrove for the rest of the run.) Divergence, deliberate:
    // the Pokecenter itself is stored rather than the outdoor map resolved
    // through spawn_points.asm; same building, landing on its door.
    this.updateWhiteoutSpawn(def, mapId);

    // ResetFlashIfOutOfCave: the FLASH flag survives a warp between two cave
    // floors and dies the moment you step out onto a ROUTE or a TOWN.
    if (def.environment === "ROUTE" || def.environment === "TOWN") {
      this.flashUsed = false;
    }
    // No noteFlypoint call: MAPCALLBACK_NEWMAP below is a town's own `setflag
    // ENGINE_FLYPOINT_*`. The map load repaints everything, so a fade sheet
    // and a screen shake left over from the warping script cannot survive it
    // (LoadMapPalettes and DeleteMapObject end both on the cart).
    this.fade = undefined;
    this.fadeHold = undefined;
    this.fadeWhiten = undefined;
    this.shake = undefined;
    this.skyfall = undefined;
    if (this.player) this.player.spriteYOffset = undefined;
    this.map = Map.new(def, tileset);
    this.rebuildAttrGrid();
    // A follow pairing points at two live objects, and a map load rebuilds
    // them (RefreshMapSprites).
    this.followState = undefined;
    this.playerMasked = undefined;
    // EnterMap's SetUpFiveStepWildEncounterCooldown (engine/overworld/
    // events.asm:110, :367-370): four encounter-free steps after every entry.
    this.wildCooldown = 5;
    // Resolve colors before baking: the daytime has to be settled before
    // imageFor picks a cache key -- and before a TILES callback's `changeblock`
    // re-bakes through World:refreshMapImages.
    this.applyPalettes();
    // GetWarpDestCoords / EnterMapConnection / EnterMapSpawnPoint write wXCoord
    // and wYCoord BEFORE HandleNewMap (data/maps/setup_scripts.asm:79-106).
    const face = truthy(facing) ? facing
      : (this.player && truthy(this.player.facing)) ? this.player.facing : "down";
    const playerDef = this.sprites ? this.sprites[this.playerSpriteName()] : undefined;
    if (this.player) {
      this.player.cellX = cx;
      this.player.cellY = cy;
      this.player.px = cx * 16;
      this.player.py = cy * 16;
      this.player.facing = face;
      if (truthy(playerDef) && !truthy(this.player.sprite)) {
        this.player.setSprite(playerDef);
      }
      if (!truthy(opts.seamless)) {
        this.player.moving = false;
        this.player.progress = 0;
        this.player.targetX = undefined;
        this.player.targetY = undefined;
      }
    } else {
      this.player = Player.new(cx, cy, face, playerDef);
    }
    // LoadMapObjects rebuilds OBJECT_FLAGS2 from scratch, so IN_GRASS is
    // decided by the arrival cell (engine/overworld/map_objects.asm:247).
    this.player.inGrass = this.grassAt(cx, cy);
    this.player.grassShake = undefined;
    // HandleNewMap (home/map.asm), in its own order: MAPCALLBACK_NEWMAP, then
    // ClearCmdQueue, then MAPCALLBACK_CMDQUEUE. The queue never survives a map
    // load on the cart either.
    //
    // Every setup script that reaches setMap -- Warp, BadWarp, Door, Fall,
    // Teleport, Train, Connection -- carries HandleNewMap, LoadBlockData and
    // LoadMapObjects, so all four callbacks belong here. `reloadmap` is
    // World:rebuildPeople (no load), ReturnToMapFromSubmenu has no port
    // equivalent, and a continue builds objects like any other load (the port
    // derives visibility from the flags rather than restoring wMapObjects).
    this.runMapCallback("MAPCALLBACK_NEWMAP");
    CmdQueue.clear(this.cmdQueue);
    this.writeCmdQueue();
    // LoadBlockData: MAPCALLBACK_TILES, with the block buffer already refilled
    // by restoreBlocks above and nothing baked off it yet.
    this.runMapCallback("MAPCALLBACK_TILES");
    // LoadMapGraphics has no failure arm (data/maps/setup_scripts.asm:41): a
    // failed bake reports through self.status and the rest of the setup runs.
    this.mapImage = this.imageFor(mapId);
    if (!truthy(this.mapImage)) {
      this.status = "Could not bake " + tostring(mapId);
    }
    if (truthy(opts.seamless)) {
      this.warpCooldown = undefined;
    } else {
      // Don't re-trigger the arrival warp until the player steps off.
      this.warpCooldown = { x: cx, y: cy };
    }
    this.rebuildNeighbors();
    // LoadMapObjects (engine/overworld/map_setup.asm): MAPCALLBACK_OBJECTS,
    // and only THEN LoadObjectMasks / InitializeVisibleSprites -- the
    // callback's appear/disappear decide which objects the rebuild finds.
    this.runMapCallback("MAPCALLBACK_OBJECTS");
    // LoadObjectMasks itself, the load this visit's masks come from.
    this.loadObjectMasks();
    // CheckUpdatePlayerSprite (engine/overworld/map_setup.asm): the Cycling
    // Road puts the player ON the bike, an INDOOR / DUNGEON map takes them off,
    // and the surf arms follow CheckOnWater (the tile STOOD on). After
    // MAPCALLBACK_NEWMAP (which sets ENGINE_ALWAYS_ON_BIKE) and before the
    // music below, which reads the state back.
    this.applyPlayerState(Bike.mapSetupState(
      this.playerState, def.environment, this.alwaysOnBike(),
      Permissions.isWater(this.map.cellCollision(cx, cy))));
    this.rebuildPeople({ seamless: opts.seamless });
    // rebuildPeople may have pooled fresh NPCs; give them their colors too.
    this.applyPalettes();
    this.setMapMusic(mapId, opts.seamless);
    // map.entered fires with the map fully built and BEFORE the map's own scene
    // script. `via` is Gen 1's four words plus "continue"
    // (MapSetupScript_Continue). The follower goes ahead of the emit
    // (src/world/OverworldController.lua:446's position).
    Follower.onMapEntered(this.game, this, opts, true);
    const via = truthy(opts.via) ? opts.via
      : truthy(opts.continue) ? "continue"
      : truthy(opts.seamless) ? "connection"
      : (truthy(fromMapId) ? "warp" : "boot");
    // ../pokecrystal/engine/overworld/warp_connection.asm:317
    // ../pokecrystal/data/maps/setup_scripts.asm:93
    MapNameSign.init(this, via);
    Runtime.emit("map.entered", {
      mapId, map: this.map, fromMapId,
      via,
    });
    // Map-enter scene scripts (e.g. Elm lab walk-up at scene 0).
    if (!truthy(opts.seamless)) {
      this.pendingSceneScript = true;
    }
    // engine/overworld/events.asm:98
    if (!this.startedOverworld && this.game && this.game.save) {
      this.startedOverworld = true;
      Phone.onMapLoad(this.game.save, this.stepContext().phone);
    }
    // The setup script runs to its `db -1` either way, so the load reports
    // true and only self.status carries a failed bake
    // (data/maps/setup_scripts.asm:53).
    if (truthy(this.mapImage)) this.status = undefined;
    return true;
  }

  // Lua: World.lua:10061-10088
  // PLAYEREVENT_WARP -> WarpToNewMapScript (engine/overworld/events.asm) is
  // `warpsound / newloadmap MAPSETUP.DOOR / end`: the sound GetWarpSFX picks
  // off the tile STOOD on (read before the load), then the DOOR setup script
  // with the load inside it.
  // home/map.asm GetDestinationWarpNumber: a `warp_event` whose destination
  // warp number is -1 ($ff) takes the whole triple out of wBackupWarpNumber
  // and friends -- one elevator door, seven floors. A $ff warp with nothing
  // written there yet keeps the destination the map declared.
  // Returns the TUPLE [destMapId, destWarpNumber] (Lua's two returns; the warp
  // number is the game's 1-based one: dest.warps[n - 1]).
  resolveWarp(warpDef: any): [any, any] {
    if (warpDef.destWarp !== 0xff) {
      return [warpDef.destMap, warpDef.destWarp];
    }
    const backup = this.backupWarp;
    if (!(backup && truthy(backup.map) && truthy(this.maps[backup.map]))) {
      return [warpDef.destMap, warpDef.destWarp];
    }
    return [backup.map, backup.warp];
  }

  // Lua: World.lua:10090-10134
  // The other half of the -1 contract, from the arrival side. CopyWarpData
  // (home/map.asm) stores the warp stepped ON and the map left in wPrevWarp /
  // wPrevMapGroup / wPrevMapNumber, and LoadMapAttributes copies that triple
  // into wBackupWarpNumber & co. whenever the warp ARRIVED ON declares
  // destination -1 -- what lets the shared POKECENTER_2F staircase lead back
  // down into whichever centre was climbed (else the player is trapped
  // upstairs). EnterMapWarp's .SaveDigWarp is the second writer of the same
  // triple (outdoor -> indoor door), so Dig and Escape Rope pay out to THAT
  // entrance; this port banks one triple for both readers
  // (World:escapeRopeTarget).
  recordWarpBackup(prevMapId: any, prevWarpIndex: any, arrivalWarp: any,
                   destMapId: any): void {
    if (!(truthy(prevMapId) && truthy(prevWarpIndex))) return;
    if (arrivalWarp && arrivalWarp.destWarp === 0xff) {
      this.backupWarp = { warp: prevWarpIndex, map: prevMapId };
      return;
    }
    if (DIG_WARP_EXCLUDED[prevMapId]) return;
    const from = this.maps ? this.maps[prevMapId] : undefined;
    const into = truthy(destMapId) && this.maps ? this.maps[destMapId] : undefined;
    if (!(truthy(from) && truthy(into))) return;
    if (!DIG_WARP_OUTDOOR[from.environment]) return;
    if (!DIG_WARP_INDOOR[into.environment]) return;
    this.backupWarp = { warp: prevWarpIndex, map: prevMapId };
  }

  // Lua: World.lua:10136-10144
  // wPrevWarp's find: the 1-based index of the warp event being stepped on,
  // in the map that declared it. Warp defs are shared tables, so identity is
  // the match.
  warpIndexOf(warpDef: any): number | undefined {
    const warps = this.map && this.map.def ? this.map.def.warps : undefined;
    const rows: any[] = warps ?? [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] === warpDef) return i + 1;
    }
    return undefined;
  }

  // Lua: World.lua:10151-10209
  takeWarp(warpDef: any): any {
    if (!warpDef || !truthy(warpDef.destMap)) return false;
    let [destMapId, destWarpNumber] = this.resolveWarp(warpDef);
    const dest = this.maps[destMapId];
    if (!truthy(dest)) return false;
    const destWarp = dest.warps ? dest.warps[destWarpNumber - 1] : undefined;
    if (!truthy(destWarp)) return false;
    let destX = destWarp.x;
    let destY = destWarp.y;
    // ctx keeps Gen 1's three keys. `lastMap` is the -1 backup triple;
    // `destWarp` is the warp NUMBER the resolve landed on. A reroute onto a map
    // this cache does not hold is refused here rather than left for setMap, so
    // the sound and the backup writes never happen for a warp that cannot be
    // taken.
    if (Runtime.wantsHook("warp.destination")) {
      [destMapId, destX, destY] = Runtime.call("warp.destination", warped,
        destMapId, destX, destY,
        { warp: warpDef, lastMap: this.backupWarp, destWarp: destWarpNumber,
          data: this.game ? this.game.data : undefined, maps: this.maps });
      if (!(truthy(destMapId) && truthy(this.maps[destMapId]) && truthy(destX) && truthy(destY))) {
        return false;
      }
    }
    // loads under MAPSETUP_FALL -- engine/overworld/events.asm:349-353
    const p = this.player;
    const falling = (p && this.map
      && isPitCollision(this.map.cellCollision(p.cellX, p.cellY))) || false;
    if (!falling) this.warpSound();
    // wBackupMapGroup / wBackupMapNumber: the map being LEFT. The elevator's
    // .FindCurrentFloor is the only reader ("Now on:" the floor you got in).
    this.backupMapId = this.map ? this.map.id : undefined;
    // wPrevWarp / wPrevMapGroup / wPrevMapNumber, read before the load pulls
    // the source map out from underfoot.
    const prevMapId = this.map ? this.map.id : undefined;
    const prevWarpIndex = this.warpIndexOf(warpDef);
    // Gen 1's five payload keys with the HOOKED coordinates, plus `toWarp`.
    Runtime.emit("player.warped", { fromMap: prevMapId, toMap: destMapId,
                                    x: destX, y: destY, warp: warpDef,
                                    toWarp: destWarpNumber });
    const taken = this.runMapSetup(falling ? MAPSETUP.FALL : MAPSETUP.DOOR,
      () => {
        const ok = this.setMap(destMapId, destX, destY,
          (this.player && truthy(this.player.facing)) ? this.player.facing : "down");
        if (ok) {
          this.spawnFacing();
          this.recordWarpBackup(prevMapId, prevWarpIndex, destWarp, destMapId);
        }
        return ok;
      });
    if (falling) {
      if (this.mapSetup) this.mapSetup.fallIn = true; else this.startSkyfall();
    }
    return taken;
  }

  // Lua: World.lua:10211-10231
  // RefreshPlayerSprite (engine/overworld/map_objects.asm) is the whole rule
  // for the facing a map load leaves: CheckWarpFacingDown against the tile
  // ARRIVED on, then `call c, SpawnInFacingDown`; any other tile keeps the
  // facing walked in with. After the load, because the array is indexed by
  // the DESTINATION map's wPlayerTileCollision.
  spawnFacing(): void {
    const p = this.player;
    if (!(this.map && p)) return;
    if (Permissions.warpFacesDown(this.map.cellCollision(p.cellX, p.cellY))) {
      p.facing = "down";
    }
  }

  // Lua: World.lua:10233-10244
  // A neighbour map, built once and kept for its collision alone: the seam
  // queries below run on the per-step path. `false` caches a miss.
  connectionMap(mapId: any): Map | undefined {
    this.connectionMaps = this.connectionMaps ?? {};
    const cached = this.connectionMaps[mapId];
    if (cached !== undefined) return cached || undefined;
    const def = this.maps[mapId];
    const tileset = truthy(def) ? this.tilesets[def.tileset] : undefined;
    const map = (truthy(def) && truthy(tileset)) ? Map.new(def, tileset) : false;
    this.connectionMaps[mapId] = map;
    return map || undefined;
  }

  // Lua: World.lua:10246-10269 -- home/map.asm:1908 GetMovementPermissions
  cellCollisionAcross(map: any, cx: number, cy: number): any {
    if (map.inBounds(cx, cy)) return map.cellCollision(cx, cy);
    let dir: Facing | undefined;
    if (cy < 0) dir = "up";
    else if (cy >= map.heightCells) dir = "down";
    else if (cx < 0) dir = "left";
    else if (cx >= map.widthCells) dir = "right";
    const conn = dir ? map.connection(DIR_CONN[dir]!) : undefined;
    const dest = conn && truthy(conn.mapId) ? this.maps[conn.mapId] : undefined;
    const destMap = truthy(dest) ? this.connectionMap(conn.mapId) : undefined;
    if (destMap) {
      const landing = Map.connectionLanding(dest, conn, dir!, cx, cy);
      const vertical = dir === "up" || dir === "down";
      const want = (vertical ? cx : cy) - (conn.offset ?? 0) * 2;
      // connectionLanding clamps into the destination; past the end of the
      // strip the buffer still holds this map's own border block
      if (landing && (vertical ? landing[0] : landing[1]) === want) {
        return destMap.cellCollision(landing[0], landing[1]);
      }
    }
    return map.cellCollision(cx, cy);
  }

  // Lua: World.lua:10271-10311
  // Seamless edge cross: swap map data, park the player one cell before the
  // landing (same world pixels the neighbor strip already showed), and keep
  // the step running so the seam does not hitch.
  tryConnection(dir: Facing): boolean {
    const connKey = DIR_CONN[dir]!;
    const conn = this.map.connection(connKey);
    if (!truthy(conn) || !truthy(conn.mapId)) return false;
    const dest = this.maps[conn.mapId];
    if (!truthy(dest)) return false;
    const landing = Map.connectionLanding(
      dest, conn, dir, this.player.cellX, this.player.cellY);
    if (!landing) return false;
    const [x, y] = landing;
    const destMap = this.connectionMap(conn.mapId);
    if (!destMap) return false;
    // home/map.asm:1946 GetMovementPermissions side-wall arm
    if (Permissions.neighborBlocks(dir, destMap.cellCollision(x, y)) === dir) {
      return false;
    }
    // A surfing crossing lands on water, which isWalkable refuses; the arm the
    // step would have taken decides, the same as inside the map.
    let landable: boolean;
    if (FieldMoves.isSurfing(this.playerState)) {
      landable = Permissions.surfable(destMap.cellCollision(x, y)) !== undefined;
    } else {
      landable = destMap.isWalkable(x, y);
    }
    if (!landable) return false;

    const p = this.player;
    const d = Map.DELTA[dir]!;
    this.setMap(conn.mapId, x, y, dir, { seamless: true });
    p.cellX = x - d[0];
    p.cellY = y - d[1];
    p.px = p.cellX * 16;
    p.py = p.cellY * 16;
    p.facing = dir;
    p.targetX = x;
    p.targetY = y;
    p.moving = true;
    p.bumpFrames = undefined;
    p.progress = 0;
    // Lua: `FixedStep:discardCatchup()` -- drops the LÖVE loop's catch-up
    // debt after a seam crossing (frame pacing on the desktop host). The 3DS
    // host ticks the guest itself and has no accumulator, so it is not called.
    return true;
  }

  // Lua: World.lua:10313-10331
  // .TranslateIntoMovement (engine/overworld/player_movement.asm) picks the
  // arm off wPlayerState; .Normal and .Surf differ only in the permission test
  // (.CheckLandPerms vs .CheckSurfPerms, LAND and WATER alike) and in what a
  // LAND answer means (.ExitWater). Player:tryMove owns the timing, so the
  // surf arm hands it a proxy that answers .CheckSurfPerms.
  surfMap(map?: any): StepMap_W7 {
    const m = map ?? this.map;
    return {
      inBounds: (x: number, y: number) => m.inBounds(x, y),
      isWalkable: (x: number, y: number) =>
        Permissions.surfable(m.cellCollision(x, y)) !== undefined,
    };
  }

  // Lua: World.lua:10348-10380
  // .TryJump: the refused step becomes a two-cell STEP_LEDGE when the player
  // STANDS on a ledge tile whose .ledge_table row includes the facing, after
  // .TryStep fails for any reason. The landing tile is checked here where the
  // cart does not bother -- no real map has a blocked landing, and a hop into
  // scenery would strand the player.
  tryLedgeJump(dir: Facing): boolean {
    const p = this.player;
    const map = this.map;
    const facings = Permissions.ledgeFacings(
      map.cellCollision(p.cellX, p.cellY));
    if (!(facings && facings[dir])) return false;
    const d = Map.DELTA[dir]!;
    const tx = p.cellX + d[0] * 2;
    const ty = p.cellY + d[1] * 2;
    if (!map.inBounds(tx, ty)) return false;
    if (!map.isWalkable(tx, ty)) return false;
    for (const e of this.entities ?? []) {
      if (e !== p) {
        if (e.cellX === tx && e.cellY === ty) return false;
        if (truthy(e.moving) && e.targetX === tx && e.targetY === ty) return false;
      }
    }
    p.targetX = tx;
    p.targetY = ty;
    p.moving = true;
    p.jumping = true;
    p.bumpFrames = undefined;
    // JumpStep res IN_GRASS_F and calls neither UpdateTallGrassFlags nor
    // ShakeGrass (engine/overworld/movement.asm:741-770).
    p.inGrass = false;
    p.grassShake = undefined;
    p.progress = 0;
    // engine/overworld/map_objects.asm:1163
    p.stepFrames = Player.STEP_FRAMES * 2;
    this.playSfxNamed("Sfx_JumpOverLedge", SFX.JUMP_OVER_LEDGE);
    return true;
  }

  // Lua: World.lua:10382-10390
  // NormalStep's begin-of-step grass work (engine/overworld/movement.asm:
  // 657-674); UpdateTallGrassFlags only RE-tests while IN_GRASS is set
  // (map_objects.asm:226).
  playerStepGrass(): void {
    const p = this.player;
    if (!(p && truthy(p.moving)) || truthy(p.jumping) || (p.progress ?? 0) !== 0) return;
    const grass = this.grassAt(p.targetX ?? p.cellX, p.targetY ?? p.cellY);
    if (truthy(p.inGrass)) p.inGrass = grass;
    p.grassShake = truthy(grass) ? grass : undefined;
  }

  // Lua: World.lua:10392-10474
  movePlayer(dir: Facing): string | undefined {
    const p = this.player;
    const map = this.map;
    // .DoStep's choice between STEP_WALK and STEP_BIKE, made fresh for every
    // step (the downhill exception can change from cell to cell).
    p.stepFrames = Bike.stepFrames(
      this.playerState, dir, this.downhill(), Player.STEP_FRAMES);
    // movement.speed, Gen 1's name and ctx keys plus `downhill` and
    // `playerState`. Per-step hot path: the ctx is only built for a chain.
    if (Runtime.wantsHook("movement.speed")) {
      const save = this.game ? this.game.save : undefined;
      const frames = Runtime.call("movement.speed", sameFrames, p.stepFrames, {
        onBike: FieldMoves.isBiking(this.playerState),
        surfing: FieldMoves.isSurfing(this.playerState),
        downhill: truthy(this.downhill()),
        playerState: this.playerState,
        player: p,
        input: this.game ? this.game.input : undefined,
        save,
      });
      p.stepFrames = Math.max(1, Math.floor(tonumber(frames) ?? p.stepFrames));
    }
    // GetMovementPermissions: the standing tile's side-wall kind and Gold's
    // neighbour arms veto the direction before any walkable test runs, for
    // walking and surfing alike (same wTilePermissions).
    let permitted = Permissions.stepPermitted(
      (x: number, y: number) => this.cellCollisionAcross(map, x, y),
      p.cellX, p.cellY, dir);
    // `.CheckNPC`'s IsNPCAtCoord answers for a BIG_OBJECT's whole 2x2 blob,
    // while Player:tryMove compares one cell -- so the three cells the
    // Vermilion Snorlax overhangs are vetoed here, with the same turn-still-
    // happens refusal shape.
    if (permitted) {
      const d = Map.DELTA[dir];
      const npc = d ? this.npcAt(p.cellX + d[0], p.cellY + d[1]) : undefined;
      if (npc && truthy(npc.bigObject)) permitted = false;
    }
    let result: string | undefined;
    if (!FieldMoves.isSurfing(this.playerState)) {
      result = p.tryMove(dir, permitted ? map : refusingMap(map),
                         this.entities);
      if (result === "blocked" && this.tryLedgeJump(dir)) {
        result = "moved";
      }
    } else {
      result = p.tryMove(dir, permitted ? this.surfMap(map)
                              : refusingMap(map), this.entities);
      if (result === "moved"
          && Permissions.surfable(map.cellCollision(p.targetX, p.targetY))
            === "land") {
        // .ExitWater: GetOutOfWater writes PLAYER_NORMAL before .DoStep, then
        // PlayMapMusic swaps the surf theme back (home/audio.asm:308)
        this.applyPlayerState(FieldMoves.PLAYER_NORMAL);
        const audio = this.game && this.game.data ? this.game.data.audio : undefined;
        if (audio && truthy(audio.runtime)) {
          Music.playMap(this.game.data, map.id, undefined,
                        FieldMoves.isSurfing(this.playerState), undefined,
                        this.mapMusicSong(map.id));
        }
      }
    }
    // .DoStep's .FinishFacing latch, and .StandInPlace / ._WalkInPlace
    // clearing it: a step OR turn records the direction; a bump (blocked /
    // edge) ends an ice slide.
    if (result === "moved" || result === "turned") {
      this.turningDirection = dir;
    } else if (result === "blocked" || result === "edge") {
      this.turningDirection = undefined;
    }
    // .NotMoving and .Ice's own arm (player_movement.asm:102 and :87), which
    // .TryJump's carry (:376) returns above.
    if (result === "blocked") this.bumpSound();
    // NormalStep, in order (engine/overworld/movement.asm:657-674): InitStep
    // has already moved OBJECT_TILE_COLLISION onto the destination.
    if (result === "moved") this.playerStepGrass();
    return result;
  }

  // Lua: World.lua:10476-10483
  clearWarpCooldownIfLeft(): void {
    const cool = this.warpCooldown;
    if (!cool) return;
    const p = this.player;
    if (p.cellX !== cool.x || p.cellY !== cool.y) {
      this.warpCooldown = undefined;
    }
  }

  // Lua: World.lua:10485-10490
  warpsSuppressed(): boolean {
    const cool = this.warpCooldown;
    if (!cool) return false;
    const p = this.player;
    return p.cellX === cool.x && p.cellY === cool.y;
  }

  // Lua: World.lua:10492-10516
  // Answers whether it TOOK a warp; World:step ends the step on a true.
  // Stepping onto a warp tile is PLAYEREVENT_WARP: DoPlayerEvent hands the
  // frame to WarpToNewMapScript, so that frame's DoPlayerMovement never runs
  // (else a held direction took one free step past the door -- Elm's Lab's
  // walk-up ended at (4,1) rather than (4,2)).
  checkWarpOnArrive(): boolean {
    const p = this.player;
    const coll = this.map.cellCollision(p.cellX, p.cellY);
    if (!Permissions.isWarpCollision(coll)) return false;
    const entry = this.map.warpAt(p.cellX, p.cellY);
    if (!entry) return false;
    if (Permissions.isImmediateWarp(coll)) {
      if (this.warpsSuppressed()) return false;
      return truthy(this.takeWarp(entry.def));
    }
    const need = Permissions.carpetDirection(coll);
    if (need && this.heldDir === need) {
      return truthy(this.takeWarp(entry.def));
    }
    return false;
  }

  // Lua: World.lua:10518-10531
  checkCarpetWhileStanding(): boolean {
    const p = this.player;
    if (truthy(p.moving) || !truthy(this.heldDir)) return false;
    const coll = this.map.cellCollision(p.cellX, p.cellY);
    const need = Permissions.carpetDirection(coll);
    if (need && this.heldDir === need) {
      const entry = this.map.warpAt(p.cellX, p.cellY);
      if (entry) {
        this.takeWarp(entry.def);
        return true;
      }
    }
    return false;
  }

  // ---- Map callbacks (home/map.asm RunMapCallback) ----

  // Lua: World.lua:10537-10546
  // RunMapCallback.FindCallback: the FIRST row whose execution index matches.
  // A second row of the same type is dead on the cart, so it is dead here.
  mapCallbackScript(kind: string): any {
    const def = this.map ? this.map.def : undefined;
    for (const cb of (def && def.callbacks) ?? []) {
      if (cb.callback === kind && truthy(cb.scriptKey)) return cb.scriptKey;
    }
    return undefined;
  }

  // Lua: World.lua:10548-10569
  // RunMapCallback proper, a nested run through the interpreter (see
  // Vm:runCallback for why it cannot block). The five types and where the
  // cart runs each:
  //   MAPCALLBACK_NEWMAP    HandleNewMap, before the block buffer is filled
  //   MAPCALLBACK_CMDQUEUE  HandleContinueMap, right after ClearCmdQueue
  //   MAPCALLBACK_TILES     LoadBlockData, after the buffer is refilled
  //   MAPCALLBACK_OBJECTS   LoadMapObjects, before the object list goes live
  //   MAPCALLBACK_SPRITES   LoadUsedSpritesGFX -- no Gold map has one
  // Gold's 84 callbacks are 39 NEWMAP, 24 OBJECTS, 19 TILES and 2 CMDQUEUE.
  runMapCallback(kind: string): boolean {
    const key = this.mapCallbackScript(kind);
    if (!(truthy(key) && this.vm)) return false;
    return truthy(this.vm.runCallback(key));
  }

  // ---- wCmdQueue (engine/overworld/cmd_queue.asm, home/stone_queue.asm) ----

  // Lua: World.lua:10575-10601
  // MAPCALLBACK_CMDQUEUE, and the `writecmdqueue` command that is its whole
  // body on both maps that have one. The extracted callback is preferred (the
  // extractor follows `writecmdqueue`'s operand into the stonetable);
  // CmdQueue.STONE_TABLES stays as the fallback for an older cache. This READS
  // the callback rather than running it: CmdQueue.write wants the entry back
  // as a value, and running the body as well would write the queue twice.
  extractedCmdQueue(): any {
    const key = this.mapCallbackScript("MAPCALLBACK_CMDQUEUE");
    if (!truthy(key)) return undefined;
    for (const cmd of this.scripts[key] ?? []) {
      if (cmd.op === "writecmdqueue") {
        const entry = CmdQueue.fromExtracted(cmd.queue, this.map.id);
        if (truthy(entry)) return entry;
      }
    }
    return undefined;
  }

  // Lua: World.lua:10603-10608
  writeCmdQueue(): boolean {
    if (!this.map) return false;
    const extracted = this.extractedCmdQueue();
    const entry = truthy(extracted) ? extracted : CmdQueue.mapEntry(this.map.id);
    if (!truthy(entry)) return false;
    return CmdQueue.write(this.cmdQueue, entry) != null;
  }

  // Lua: World.lua:10610-10612
  delCmdQueue(kind: any): any {
    return CmdQueue.delete(this.cmdQueue, kind);
  }

  // Lua: World.lua:10614-10646
  // HandleCmdQueue, once a frame from the overworld loop -- so not while a
  // script is up, which also stops the queue re-firing on the boulder it is
  // already removing. The objects are the port's NPCs wearing the CART's
  // object ids (`object_const_def` is `const_def 2`), which a stonetable row
  // names.
  handleCmdQueue(): boolean {
    if (!(this.map && this.vm)) return false;
    if (this.busy()) return false;
    if (CmdQueue.count(this.cmdQueue) === 0) return false;
    const objects: any[] = [];
    for (const npc of this.npcs) {
      const obj = npc.def;
      if (obj && obj.index != null) {
        objects.push({
          id: obj.index + 1,
          movement: obj.movement,
          cellX: npc.cellX, cellY: npc.cellY,
          moving: truthy(npc.moving),
        });
      }
    }
    const map = this.map;
    const row = CmdQueue.poll(this.cmdQueue, {
      objects,
      warps: (map.def && map.def.warps) ?? [],
      collisionAt: (x: number, y: number) => map.cellCollision(x, y),
    });
    if (!truthy(row)) return false;
    // CallMapScript + EnableScriptMode: the row's script runs like any other.
    return this.vm.start(row!.script);
  }

  // ---- The per-step event chain (engine/overworld/events.asm CountStep) ----
  // world/StepEvents owns the ORDER and the counters; everything here is the
  // presentation the cart's player-event scripts put over it.

  // Lua: World.lua:10660-10680 -- what CountStep's routines need from outside
  // the save.
  stepContext(): any {
    const def = this.map ? this.map.def : undefined;
    return {
      data: this.game ? this.game.data : undefined,
      // CheckTime reads wTimeOfDay (engine/events/checktime.asm:2), so the
      // caller windows follow the clock even inside a pinned-palette room.
      phone: {
        map: def, maps: this.maps, daytime: this.tod,
        clock: this.game ? this.game.clock : undefined,
      },
      // GetMapPhoneService: zero means the map HAS service, which maps.json
      // has already decoded into a boolean.
      phoneService: def ? def.phoneService : undefined,
      playerState: this.playerState,
      // "Don't count steps in link communication rooms." No link overworld
      // room here, so the gate can only ever be false.
      linkMode: false,
    };
  }

  // Lua: World.lua:10682-10708
  // CheckTileEvent calls this between the coord events and the wild roll; a
  // CARRY out of it queues a player event. True when the caller must stop the
  // step: an egg that hatched or a mon that dropped to poison does not also
  // walk into a Rattata.
  countStep(): boolean {
    const save = this.game ? this.game.save : undefined;
    if (!save) return false;
    const event: any = StepEvents.count(save, this.stepContext());
    if (!truthy(event)) return false;
    if (event.kind === "hatch") {
      // PLAYEREVENT_HATCH is HatchEggScript: `callasm OverworldHatchEgg /
      // end`, routed through the callasm registry so the routine has exactly
      // one port.
      CallAsm.run(this, "OverworldHatchEgg");
    } else if (event.kind === "poisonFaint") {
      this.poisonFaintScript(event);
    } else if (event.kind === "poisonHurt") {
      // .PlayPoisonSFX alone: the sound and the four-frame BG flash.
      CallAsm.run(this, "PlayPoisonSFX");
    } else if (event.kind === "repel") {
      this.repelWoreOff();
    } else if (event.kind === "phoneCall") {
      this.receivePhoneCall(event.call);
    }
    return truthy(event.blocks);
  }

  // Lua: World.lua:10710-10713 -- RepelWoreOffScript (engine/events/
  // repel.asm): opentext, one line, waitbutton.
  repelWoreOff(): void {
    this.showText(Strings.get("REPEL's effect\nwore off."));
  }

  // Lua: World.lua:10715-10744
  // .Script_MonFaintedToPoison, via .CheckWhitedOut: one line per mon that
  // dropped, HAPPINESS_POISONFAINT applied to each BEFORE its text, and the
  // whiteout only after every fainted mon has been named. `event.fainted`
  // holds 1-based party slots (party[index - 1]).
  poisonFaintScript(event: any): void {
    const save = this.game ? this.game.save : undefined;
    const party: any[] = (save && save.party) ?? [];
    const lines: string[] = [];
    for (const index of event.fainted ?? []) {
      const mon = party[index - 1];
      if (mon) {
        Happiness.change(mon, "HAPPINESS_POISONFAINT");
        lines.push(Strings.get("%s\nfainted!", monName(mon)));
      }
    }
    CallAsm.run(this, "PlayPoisonSFX");
    let i = 0;
    const next = (): void => {
      i = i + 1;
      if (lines[i - 1] != null) {
        this.showText(lines[i - 1], next);
        return;
      }
      if (truthy(event.whiteout)) this.whiteOut();
    };
    next();
  }

  // Lua: World.lua:10746-10776
  // OverworldWhiteoutScript's tail, for the poison path only (the Bug Contest
  // abort is not modelled): HalveMoney (the wallet only) plus the trip back to
  // the spawn point. Both callasm halves go through the registry; only
  // HalveMoney has an effect today, but the pair keeps the script order.
  whiteOut(): void {
    // Lua's "\011" is decimal 11 (0x0b), kept as the same byte.
    this.showText(
      Strings.get("You have no more\nPOKéMON that can\x0bfight!"), () => {
        CallAsm.run(this, "HalveMoney");
        CallAsm.run(this, "GetWhiteoutSpawn");
        this.healParty();
        // Guarded because healPoint walks the spawn table to answer.
        if (Runtime.wants("world.blacked_out")) {
          Runtime.emit("world.blacked_out",
            { save: this.game ? this.game.save : undefined, healTarget: this.healPoint() });
        }
        // engine/events/whiteout.asm:19-20
        this.runMapSetup(MAPSETUP.WARP, () => {
          this.warpToSpawn();
          return true;
        });
      });
  }

  // Lua: World.lua:10778-10856
  // HatchEggs (engine/pokemon/breeding.asm). One slot at a time, in party
  // order, for every egg whose counter has reached zero:
  //   "Huh?" (a `para "@"`, so the box clears and waits)
  //   EggHatch_AnimationSequence
  //   an empty box (_BreedClearboxText)
  //   "<NAME> came<LINE>out of its EGG!" with sound_caught_mon
  //   "Give a nickname to<LINE><NAME>?" -> the naming screen, or not
  // The strings are hand-written from data/text/common_2.asm (nothing a
  // script points at). The animation is ui/EggHatchAnim.
  hatchEggs(): void {
    const save = this.game ? this.game.save : undefined;
    const data = this.game ? this.game.data : undefined;
    if (!(save && data)) return;
    // 1-based party slots, in party order.
    const queue = Breeding.readyToHatch(save);
    let at = 0;
    const nextEgg = (): void => {
      at = at + 1;
      const index = queue[at - 1];
      if (index == null) {
        // RestartMapMusic: the standard menu header the hatch ran under is gone.
        this.restoreMapMusic();
        return;
      }
      this.showText("Huh?", () => {
        const [hatched, effects] =
          Breeding.hatch(data, save, index, undefined, this.caughtDataOpts());
        if (!hatched) return nextEgg();
        // Breeding.hatch already ran SetSeenAndCaughtMon; the Togepi flag is
        // handed back because wEventFlags belongs to the world (keyed by
        // NUMBER).
        if (effects && effects.togepi && this.events) {
          this.events.set(EVENT_TOGEPI_HATCHED, true);
          this.peopleDirty = true;
        }
        const name = monName(hatched);
        const announce = (): void => {
          // `sound_caught_mon` sits inside _BreedEggHatchText, before its
          // text_promptbutton: the jingle plays as the line lands.
          this.playSfxNamed("Sfx_CaughtMon", 2);
          this.showText(Strings.get("%s came\nout of its EGG!", name), () => {
            // _BreedAskNicknameText ends `done`, so YesNoBox opens over the
            // question with no press in between: askYesNo's instant re-show
            // of lastText.
            this.lastText = Strings.get("Give a nickname to\n%s?", name);
            this.askYesNo((yes: boolean) => {
              if (!yes) return nextEgg();
              this.nameHatchling(hatched, nextEgg);
            });
          });
        };
        // EggHatch_AnimationSequence sits between the "Huh?" box and the line
        // above (engine/pokemon/breeding.asm:664). A whole screen, so it goes
        // on the stack; with no stack (a headless run) the beat is skipped.
        const game = this.game;
        if (game && game.stack) {
          Screens.push(game, "Gen2EggHatchAnim", {
            mon: hatched,
            species: hatched.species,
            menuGfx: data.gen2MenuGfx,
            onDone: () => {
              game.stack.pop();
              announce();
            },
          });
        } else {
          announce();
        }
      });
    };
    nextEgg();
  }

  // Lua: World.lua:10858-10885
  // `ld b, NAME_MON / farcall NamingScreen`, with wStringBuffer1 (the species
  // name) in the header slot. A cancelled screen is "no thanks": InitName
  // copies the species name back over the nickname either way.
  nameHatchling(mon: any, onDone: () => void): void {
    const game = this.game;
    if (!(game && game.stack)) return onDone();
    const data = game.data ?? {};
    const icons = data.gen2Icons;
    const iconId = icons && icons.species ? icons.species[mon.species] : undefined;
    const entry = iconId != null && icons.icons ? icons.icons[iconId] : undefined;
    const done = (name: any): void => {
      game.stack.pop();
      // _InitString's blank test, not a length one (home/string.asm:6-30): an
      // all-space entry falls back to the species name like an empty one.
      if (truthy(name) && String(name).replace(/ /g, "") !== "") mon.nickname = name;
      onDone();
    };
    Screens.push(game, "Gen2NamingScreen", {
      type: "nickname",
      monName: mon.name ?? mon.species,
      iconPath: entry ? entry.image : undefined,
      menuGfx: data.gen2MenuGfx,
      onDone: done,
      onCancel: () => { done(undefined); },
    });
  }

  // Lua: World.lua:10887-10923
  // Script_ReceivePhoneCall's overworld half. The caller's script (ROM bank
  // $41, reached by the extractor from PhoneContacts / SpecialPhoneCallList)
  // runs inside the ring chrome (core/PhoneRing), with wCurCaller parked on
  // the VM first for GetCallerLocation's two specials. The drop path is for
  // an older cache: clearing the queue is REQUIRED, since the cart does not
  // count a step on which a special call fires, so an unrunnable call would
  // freeze wStepCount forever and stop eggs hatching.
  receivePhoneCall(call: any): boolean {
    const key = call ? call.scriptKey : undefined;
    if (truthy(key) && this.vm && truthy(this.vm.scripts[key])) {
      const [name, className] = Phone.contactName(call.contact,
        this.game && this.game.data ? this.game.data.trainers : undefined);
      this.vm.curPhoneCaller = call.contact;
      const rows = PhoneRing.script(call, name, className);
      if (this.vm.start(rows)) return true;
    }
    const save = this.game ? this.game.save : undefined;
    if (save) Phone.clearSpecialCall(save);
    this.unrunnableCalls = (this.unrunnableCalls ?? 0) + 1;
    if (this.unrunnableCalls === 1) {
      // Lua print(): the host log.
      Logger.info("[gold] special phone call %s has no script in this cache "
        + "(re-import: bank $41 is reached from PhoneContacts); dropped so the "
        + "step counter keeps running", tostring(call ? call.specialName : undefined));
    }
    return false;
  }

  // Lua: World.lua:10925-10932
  updatePeople(): void {
    for (const npc of this.npcs) {
      npc.update(this.map, this.entities);
    }
    for (const g of this.ghosts) {
      g.npc.update(g.map, g.peers);
    }
  }

  // Lua: World.lua:10934-10971
  // Once a second, ask whether the clock rolled into a new time of day; if it
  // did, drop the baked map images so they come back in the new palette.
  pollTimeOfDay(): void {
    this.paletteClock = (this.paletteClock ?? 0) + 1;
    if (this.paletteClock < PALETTE_POLL_STEPS) return;
    this.paletteClock = 0;
    if (truthy(this.applyPalettes())) {
      this.mapImages = {};
      this.mapImage = this.imageFor(this.map.id);
      this.rebuildNeighbors();
    }
    // The hour-window objects (World:objectTimeVisible) key off the raw hour,
    // so their respawn rides the same poll (the port's stand-in for the
    // reload that refreshes wObjectMasks on the cart).
    const hour = this.hour();
    if (hour === this.lastMaskHour) return;
    // The first poll only arms the latch; there is nothing to respawn yet.
    if (this.lastMaskHour == null) {
      this.lastMaskHour = hour;
      return;
    }
    // A rollover that lands while the world is busy is NOT consumed: the latch
    // stays on the old hour so the next poll tries again.
    if (this.busy()) return;
    this.lastMaskHour = hour;
    // The hour half of LoadObjectMasks (GetObjectTimeMask) only: keepScripted
    // leaves every byte a scene wrote alone.
    this.loadObjectMasks({ keepScripted: true });
    this.rebuildPeople({ seamless: true });
  }

  // Lua: World.lua:10973-10981
  // Both tick once per logic frame AFTER the body (where src/world/
  // OverworldController.lua:1039 drives the Gen 1 pair); the body has a dozen
  // early returns, so the tail cannot live inside it.
  step(): void {
    this.stepBody();
    if (!this.map || !this.player) return;
    Follower.update(this.game, this);
    Gen1Facade.worldTick(this, 1 / 60);
  }

  // Lua: World.lua:10983-11207
  stepBody(): void {
    if (!this.map || !this.player) return;
    this.stepFinished = false;
    this.pollTimeOfDay();
    // ShakeScreen and the `musicfadeout` tail both run UNDER a script, so both
    // tick above the busy() gate rather than below it.
    if (this.shake) this.updateShake();
    if (this.skyfall) this.updateSkyfall();
    // The map setup chain ticks above the busy() gate too: it IS what closes
    // that gate, so nothing below can be allowed to advance it.
    if (this.mapSetup) {
      this.updateMapSetup();
      return;
    }
    // ../pokecrystal/engine/overworld/events.asm:212
    MapNameSign.tick(this);
    if (this.pendingMusic) this.updateMusicFade();
    if (this.moveState) this.updateMovement();
    // Above the VM tick: a `waitbutton` under a `pokepic` is parked on this
    // poll, and its resume has to run inside the same frame the press lands.
    if (truthy(this.waitButton)) this.pollWaitButton();
    if (this.vm) this.vm.update();
    // ExitAllMenus takes the balance box down with everything else the script
    // opened.
    if (truthy(this.scriptBalance) && this.vm && !this.vm.running()) {
      this.scriptBalance = undefined;
    }
    // ExitAllMenus again, for the box a `stay` left standing whose script
    // stopped early (an `sjump` out of the arm, a mod's `end`): without this
    // self.textbox stays set and World:busy() never lets the player move.
    if (this.stayedTextBox && this.vm && !this.vm.running()) {
      const held = this.stayedTextBox;
      this.stayedTextBox = undefined;
      this.textbox = undefined;
      if (this.game && this.game.stack && this.game.stack.top() === held) {
        this.game.stack.pop();
      }
    }
    // The rod cast and the tree shake tick alongside the VM rather than under
    // the busy() gate below, because that gate is what they themselves close.
    if (this.fishing) this.updateFishing();
    if (this.headbutt) this.updateHeadbutt();
    if (this.fieldMove) this.updateFieldMove();
    // QueueScript's own drain: a field move chosen from the party menu runs
    // the first frame the overworld is back on top.
    if (this.queuedFieldMove) this.runQueuedFieldMove();
    // The same drain for the ITEMFINDER's queued script.
    if (this.queuedScript) this.runQueuedScript();
    this.pollCaveFlicker();
    this.pollTileAnim();
    // Object visibility a running script changed lands here, once the script
    // is over: RefreshMapSprites' timing, not the flag write's.
    if (this.peopleDirty && !this.scriptRunning()) {
      this.peopleDirty = undefined;
      this.rebuildPeople({ seamless: true });
    }
    // UnfreezeAllObjects (engine/overworld/map_objects.asm), which EndScript
    // runs, the frame the whole interaction has settled. A rebuild between
    // the freeze and here can leave a frozen NPC only in self.npcs, so both
    // walk.
    if (this.frozeNpcs && !this.busy()) {
      this.frozeNpcs = undefined;
      const pool = this.npcPool ?? {};
      for (const k of Object.keys(pool)) pool[k].frozen = false;
      for (const npc of this.npcs ?? []) npc.frozen = false;
    }
    // WarpCheck's find, on the same clock: a script that ends standing on a
    // warp tile takes it once the script is over.
    if (this.pendingWarp && !this.scriptRunning()) {
      if (this.takePendingWarp()) return;
    }
    if (this.emote) {
      this.emote.left = this.emote.left - 1;
      if (this.emote.left <= 0) this.emote = undefined;
    }
    // The heal machine runs while the script is parked on its specialwait, so
    // it ticks here above the input gate; its last flash's onDone resumes the
    // nurse.
    if (this.healAnim) this.stepHealAnim();
    if (this.flyAnim) this.stepFlyAnim();

    // HandleCmdQueue, once a frame, above the input gate: it drops a boulder
    // already sitting on a hole, and has to see the frame the push finishes.
    if (this.handleCmdQueue()) return;

    // Fire map-enter scene script once the warp settles.
    if (this.pendingSceneScript && !this.busy()) {
      this.pendingSceneScript = false;
      if (this.trySceneScript()) return;
    }

    // CheckTimeEvents: the Bug Contest clock, whose carry is a script; above
    // the input gate, below the one that says a script is already running.
    if (!this.busy() && this.checkTimeEvents()) return;

    // Freeze player input while a script / textbox / cutscene move is up.
    if (this.busy()) {
      // Keep scripted entities animating mid-step. A step_dig spin has the
      // player standing still, so it ticks here too.
      if (this.player && (truthy(this.player.moving) || this.player.spinFrames != null)) {
        this.playerStepGrass();
        if (this.player.update()) {
          this.player.inGrass =
            this.grassAt(this.player.cellX, this.player.cellY);
        }
      } else if (this.player && this.player.stopForEvent) {
        // engine/overworld/map_objects.asm:1851-1860
        this.player.stopForEvent();
      }
      this.updatePeople();
      return;
    }

    const p = this.player;
    this.playerStepGrass();
    const landed = p.update();
    this.stepFinished = landed;
    // CopyCoordsTileToLastCoordsTile -> SetTallGrassFlags, which is what a step
    // ENDS on (engine/overworld/map_objects.asm:196-208, :247).
    if (landed) p.inGrass = this.grassAt(p.cellX, p.cellY);
    // CheckTrainerEvent is PlayerEvents' FIRST test (engine/overworld/
    // events.asm:245) and is not behind wEnabledPlayerEvents, so the sight
    // cone is sampled EVERY overworld frame (a spinner rotating onto a
    // standing player engages; a sighting during a script fires the frame it
    // ends). After p:update() (which commits cellX/cellY) and above the
    // `landed` block, so a trainer whose line crosses a warp or coord-event
    // tile wins, as on hardware (events.asm:249).
    if (this.checkTrainerBattle()) return;
    if (landed) {
      // hot path: the payload is only built when something is listening.
      // `tile` is the COLLISION byte (Gold's map has no per-cell tile id), and
      // `daytime` is the palette set beside Gen 1's `tod`.
      if (Runtime.wants("world.stepped")) {
        Runtime.emit("world.stepped", {
          mapId: this.map.id, x: p.cellX, y: p.cellY,
          tile: this.map.cellCollision(p.cellX, p.cellY),
          tod: this.tod, daytime: this.daytime,
        });
      }
      this.clearWarpCooldownIfLeft();
      if (this.checkWarpOnArrive()) return;
      if (!this.map) return;
      if (this.tryCoordScript()) return;
      // CheckTileEvent's own order: the coord events, then CountStep, then
      // RandomEncounter; a carry out of CountStep queues a player event.
      if (this.countStep()) return;
      // Grass rolls after the warp and coord checks, so stepping onto a door
      // inside grass still warps rather than starting a battle.
      if (this.tryWildEncounter()) return;
    }

    // People keep their anim paths even while the player is idle / mid-step.
    this.updatePeople();

    // .CheckForced / CheckStandingOnIce: while the tile underfoot is ice and a
    // prior step latched .FinishFacing, THIS frame's d-pad is forced to that
    // direction, so one press slides until a non-ice landing or a bump. The
    // override is local (writing heldDir would keep the player walking after
    // the slide). StandInPlace clears the latch when idle off ice.
    //
    // .CheckTile runs ABOVE both, and its HI_NYBBLE_CURRENT arm is stronger: a
    // $3x tile underfoot picks the direction outright. On COLL_WATERFALL $33
    // that is one DOWN per frame -- the automatic plunge, and why a waterfall
    // cannot be climbed by walking into it (HM07's climb is a scripted step
    // under World:busy, which returns above).
    let dir: Facing | undefined = this.heldDir;
    if (!truthy(p.moving)) {
      const coll = this.playerCollision();
      // .CheckTile tests CheckWhirlpoolTile above the nybble ladder
      // -- engine/overworld/player_movement.asm:117-123 (#1716)
      if (Permissions.isWhirlpool(coll) && this.runForcedMovement()) {
        return;
      }
      const current = Permissions.currentDirection(coll)
        ?? Permissions.doorForcedDirection(coll);
      if (current) {
        dir = current;
      } else if (this.turningDirection && Permissions.isIce(coll)) {
        dir = this.turningDirection;
      } else if (!dir) {
        this.turningDirection = undefined;
      }
    }
    if (!dir) {
      p.turnArmed = true;
      // engine/overworld/player_movement.asm:108
      p.bumpFrames = undefined;
      return;
    }
    if (truthy(p.moving)) return;

    if (this.checkCarpetWhileStanding()) return;

    const result = this.movePlayer(dir);
    if (result === "edge") {
      // A border block is a wall: engine/overworld/player_movement.asm:264
      if (!this.tryConnection(dir)) this.bumpSound();
    } else if (result === "blocked" && p.facing === dir) {
      // .CheckNPC came back 2: something movable is in the way. The step is
      // lost either way, and the boulder is what moves.
      const d = Map.DELTA[dir]!;
      this.tryPushBoulder(dir, p.cellX + d[0], p.cellY + d[1]);
    }
  }
}

// Lua: World.lua:3657-3661 -- engine/tilesets/timeofday_pals.asm:65-91,
// home/fade.asm:22-120. Each row is the four BGP shades (0-based here, so
// row[0] is the Lua's row[1]); World.fadeRampRow picks one by fade level.
World.FADE_RAMP = {
  white: [[3, 2, 1, 0], [2, 1, 0, 0], [1, 0, 0, 0], [0, 0, 0, 0]],
  black: [[3, 2, 1, 0], [3, 3, 2, 1], [3, 3, 3, 2], [3, 3, 3, 3]],
} as Record<FadeColor, number[][]>;
// Lua: World.lua:3662-3665
World.FADE_STEPS = FADE_STEPS;
World.FADE_STEP_FRAMES = FADE_STEP_FRAMES;
World.MAP_LOAD_WHITE_FRAMES = MAP_LOAD_WHITE_FRAMES;
World.WARP_LOAD_WHITE_FRAMES = WARP_LOAD_WHITE_FRAMES;
// Lua: World.lua:11815-11823 -- exported for the Gen 1 FieldDefaults facade
// (src/mods/Gen2Compat.lua) rather than duplicated there.
World.PLAYER_SPRITE = PLAYER_SPRITE;

World.FLY_MAP_BUILD_FRAMES = FLY_MAP_BUILD_FRAMES;
World.MENU_EXIT_RELOAD_FRAMES = MENU_EXIT_RELOAD_FRAMES;
World.MENU_EXIT_WHITE_FRAMES = MENU_EXIT_WHITE_FRAMES;
World.FLY_EXIT_WHITE_FRAMES = FLY_EXIT_WHITE_FRAMES;
// FLY: the fly-animation table (World.lua:6402, in the W5 locals).
World.FLY_FROM_PREROLL = FLY.FROM_PREROLL;

// ---- W7: World.lua:9814-11208 statics ---------------------------------------

// Lua: World.lua:10900 -- the count of special phone calls dropped for want of
// a script (World:receivePhoneCall bumps the instance copy).
World.unrunnableCalls = undefined;

export default World;
