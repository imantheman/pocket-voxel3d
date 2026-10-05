// Port of gen1recomp src/ui/game3/credits.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/credits.c:711 DoCredits
//
// Required lazily (pcall(require, "src.ui.game3.credits")), so it registers
// itself in G3Lazy. `package.loaded[...]` reads of space / runtime / Renderer
// are the static imports (always loaded here).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring } from "../../../import/gen3/lua.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { MapCatalog } from "../../../import/gen3/map_catalog.ts";
import { Stack } from "./stack.ts";
import { FrlgFont, type Colors } from "./frlg_font.ts";
import { Dataset } from "../core/dataset.ts";
import { Flags } from "../core/scripting/flags.ts";
import { Space } from "../core/scripting/space.ts";
import { Runtime } from "../core/runtime.ts";
import { G3Lazy } from "../core/lazy_registry.ts";
import { FieldView } from "../core/field_view.ts";
import { TilesetAnim } from "../core/tileset_anim.ts";
import { Map } from "../core/map.ts";
import { Audio } from "../core/audio.ts";
import { Pokemon } from "../core/pokemon.ts";
import { Renderer } from "../shared/render/Renderer.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type ImageData, type Quad } from "../platform/image.ts";
import { luaLoad } from "../platform/luadata.ts";
import { len, pairs, seq, type LuaTable } from "../platform/lt.ts";
import { gmatch, matchAll } from "../platform/lpattern.ts";

interface Entry { image: Image; data: ImageData; w: number; h: number; quads?: Record<number, Quad> }
interface Level { y: number; color: number[] }
interface Fade {
  groups: Record<string, boolean>; delay: number; counter: number; y: number; target: number;
  color: number[]; toggle: boolean; finishing: boolean; fcount: number; active: boolean;
}

export interface CreditsModule {
  ID: string;
  open: boolean;
  SCENE: Record<string, number>;
  CMD: Record<string, number>;
  updateFade(): void;
  isOpen(): boolean;
  state(): any;
  start(opts?: any): boolean;
  reset(): void;
  update(dt?: number): void;
  handleInput(input: any): void;
  draw(): void;
}

// pokefirered/src/credits.c:25
const SCENE = {
  INIT_WIN0: 0, SETUP_DARKEN_EFFECT: 1, OPEN_WIN0: 2, LOAD_PLAYER_SPRITE_AT_INDIGO: 3,
  PRINT_TITLE_STAFF: 4, WAIT_TITLE_STAFF: 5, EXEC_CMD: 6, PRINT_ADDPRINTER1: 7,
  PRINT_ADDPRINTER2: 8, PRINT_DELAY: 9, MAPNEXT_DESTROYWINDOW: 10, MAPNEXT_LOADMAP: 11,
  MAP_LOADMAP_CREATESPRITES: 12, MON_DESTROY_ASSETS: 13, MON_SHOW: 14,
  THEEND_DESTROY_ASSETS: 15, THEEND_SHOW: 16, WAITBUTTON: 17, TERMINATE: 18,
};

// pokefirered/src/credits.c:48
const CMD_PRINT = 0, CMD_MAPNEXT = 1, CMD_MAP = 2, CMD_MON = 3, CMD_THEENDGFX = 4, CMD_WAITBUTTON = 5;

// pokefirered/include/constants/flags.h:1530
const FLAG_DONT_SHOW_MAP_NAME_POPUP = 0x4000;
// pokefirered/src/credits.c:456
const WIN_X = 0, WIN_Y = 32;
// pokefirered/src/credits.c:453
const HEADER_FG = 5, HEADER_SHADOW = 2;
const REGULAR_FG = 1, REGULAR_SHADOW = 2;
// pokefirered/src/new_menu_helpers.c:74
const LINE_HEIGHT = 14;
const BLACK = seq(0, 0, 0) as number[], WHITE = seq(1, 1, 1) as number[];

// pokefirered/src/palette.c:151
const ALL = { world: true, text: true, sprite: true, screen: true };
const TEXT_PAL = { text: true };
const FIELD_PALS = { world: true, text: true, screen: true };

let M: any;
let images: Record<string, Entry | false> = {};

// Lua: credits.lua:48
function root(): string {
  return (Extract.CACHE_ROOT || "data/generated/gba") + "/credits/";
}

// Lua: credits.lua:52
function read(rel: string): string | undefined {
  return Dataset.cache().read(root() + rel);
}

// Lua: credits.lua:56
function load_table(rel: string): LuaTable | null {
  const src = read(rel);
  if (!src) return null;
  const [chunk] = luaLoad(src, "@credits/" + rel);
  if (!chunk) return null;
  let ok = true, v: any;
  try { v = chunk(); } catch { ok = false; }
  if (ok && v != null && typeof v === "object") return v;
  return null;
}

// Lua: credits.lua:66
function image(name: string, w: number, h: number): Entry | null {
  const key = name;
  if (images[key] != null) return images[key] || null;
  const bytes = read(name + ".rgba");
  let entry: Entry | false = false;
  if (bytes && bytes.length === w * h * 4) {
    const data = newImageData(w, h, "rgba8", bytes);
    const img = G.newImage(data);
    img.setFilter("nearest", "nearest");
    entry = { image: img, data, w, h };
  }
  images[key] = entry;
  return entry || null;
}

// Lua: credits.lua:81
function quad_cache(entry: Entry, fw: number, fh: number, frame: number): Quad {
  entry.quads = entry.quads || {};
  let q = entry.quads[frame];
  if (!q) {
    q = G.newQuad(0, frame * fh, fw, fh, entry.w, entry.h);
    entry.quads[frame] = q;
  }
  return q;
}

// Lua: credits.lua:91
function flags(): typeof Flags {
  return Flags;
}

// Lua: credits.lua:95
function store(): any {
  const S: any = Space;
  return S && S.store;
}

// Lua: credits.lua:100
function session(): any {
  const rt = Runtime;
  return rt && rt.getSession && rt.getSession();
}

// Lua: credits.lua:105
function game(): any {
  const rt = Runtime;
  return rt && rt._game;
}

// pokefirered/src/palette.c:151 BeginNormalPaletteFade
// Lua: credits.lua:111
function begin_fade(groups: Record<string, boolean>, delay: number, startY: number, targetY: number, color?: number[]): boolean {
  const f = M.fade;
  if (f && f.active) return false;
  M.fade = {
    groups, delay, counter: delay, y: startY, target: targetY,
    color: color || BLACK, toggle: false, finishing: false, fcount: 0, active: true,
  } as Fade;
  Credits.updateFade();
  return true;
}

// Lua: credits.lua:122
function fade_active(): boolean {
  return M.fade != null && M.fade.active;
}

// Lua: credits.lua:163
function set_level(g: string, y: number, color?: number[]): void {
  M.level[g] = { y, color: color || BLACK } as Level;
}

// pokefirered/src/credits.c:769
// Lua: credits.lua:168
function create_window(): void {
  M.text = null;
  M.windowActive = true;
  // pokefirered/src/credits.c:830
  set_level("text", M.level.world.y, M.level.world.color);
}

// pokefirered/src/credits.c:778
// Lua: credits.lua:176
function destroy_window(): void {
  if (M.windowActive) {
    M.text = null;
    M.windowActive = false;
  }
}

// pokefirered/src/credits.c:1336 LoadPlayerOrRivalSprite
// Lua: credits.lua:184
function load_player_or_rival(whichScene: number): void {
  if (M.task) return;
  const p = M.pack.spriteParams[whichScene];
  if (!p) return;
  let x: number, y: number;
  if (p.motion === 1) {
    x = 240 + 32; y = 80;
  } else if (p.motion === 2) {
    x = 240 - 32; y = 160;
  } else {
    x = 240 - 32; y = 80;
  }
  const s = session() || {};
  const g = s.gender ?? s.playerGender;
  const female = g === 1 || g === "female" || g === "F";
  const sheet = p.character === 1 ? "rival" : (female ? "player_female" : "player_male");
  const ground = ({ 0: "ground_grass", 1: "ground_grass", 2: "ground_dirt", 3: "ground_city" } as Record<number, string>)[p.ground];
  M.task = {
    motion: p.motion,
    sheet,
    ground,
    groundRunning: p.ground !== 1,
    x, y, gx: x, gy: y + 38,
    frame: 0, frameTimer: 0, gframe: 0, gframeTimer: 0,
  };
  set_level("sprite", 0);
}

// pokefirered/src/credits.c:1322 DestroyPlayerOrRivalSprite
// Lua: credits.lua:213
function destroy_player_or_rival(): void {
  M.task = null;
}

// pokefirered/src/credits.c:1280 Task_MovePlayerAndGroundSprites
// Lua: credits.lua:218
function run_tasks(): void {
  const t = M.task;
  if (!t) return;
  if (t.motion === 1) {
    if (t.x !== 0xD0) {
      t.x = t.x - 1; t.gx = t.gx - 1;
    } else {
      t.motion = 0;
    }
  } else if (t.motion === 2) {
    if (M.parity % 2 === 1) {
      if (t.y !== 0x50) {
        t.y = t.y - 1; t.gy = t.gy - 1;
      } else {
        t.motion = 0;
      }
    }
  } else if (t.motion === 3) {
    if (M.mainseq === SCENE.THEEND_DESTROY_ASSETS) {
      t.x = t.x - 1; t.gx = t.gx - 1;
    }
  }
}

// pokefirered/src/credits.c:499
// Lua: credits.lua:243
function animate_sprites(): void {
  const t = M.task;
  if (!t) return;
  t.frameTimer = t.frameTimer + 1;
  if (t.frameTimer >= 8) {
    t.frameTimer = 0;
    t.frame = (t.frame + 1) % 6;
  }
  if (t.groundRunning) {
    t.gframeTimer = t.gframeTimer + 1;
    if (t.gframeTimer >= 8) {
      t.gframeTimer = 0;
      t.gframe = (t.gframe + 1) % 8;
    }
  }
}

// pokefirered/src/overworld.c:2490 CameraCB_CreditsPan
// Lua: credits.lua:261
function camera_update(): void {
  const c = M.cam;
  if (!c) return;
  if (c.len === 0) {
    c.idx = c.idx + 1;
    const cmd = c.cmds[c.idx];
    if (!cmd) {
      c.sx = 0; c.sy = 0;
      M.cam = null;
      return;
    }
    c.len = cmd.length;
    c.sx = cmd.xspeed; c.sy = cmd.yspeed;
  }
  c.len = c.len - 1;
  c.px = c.px + c.sx;
  c.py = c.py + c.sy;
  FieldView.setCameraPanning(c.px, c.py);
}

// Lua: credits.lua:282
function overworld_main_cb(): void {
  camera_update();
  // pcall(require, "src.core.game3.tileset_anim"): always present here
  const TA: any = TilesetAnim;
  if (TA && TA.step) TA.step();
}

// pokefirered/src/overworld.c:2384 SetUpScrollSceneForCredits
// Lua: credits.lua:289
function load_scene_map(which: number): void {
  const scene = M.pack.scenes[which];
  const load = scene && scene[1];
  if (!(load && load.op === "loadmap")) return;
  const mapId = MapCatalog.mapIdFor(load.mapGroup, load.mapNum);
  const cmds: LuaTable = seq();
  for (let i = 2; i <= len(scene); i++) {
    if (scene[i].op === "scroll") cmds[len(cmds) + 1] = scene[i];
  }
  FieldView.setCameraPanning(0, 0);
  M.cam = { cmds, idx: 0, len: load.delay, sx: 0, sy: 0, px: 0, py: 0 };
  const g = game();
  if (g && mapId) {
    Map.load(null, g, mapId, { x: load.x, y: load.y, facing: "down" });
  }
  set_level("world", 16);
  set_level("text", 16);
}

// Lua: credits.lua:310
function scroll_scene_ready(): void {
  // pokefirered/src/credits.c:803
  create_window();
  M.win0 = { top: 36, bottom: 160 - 36 };
  M.darken = true;
}

// pokefirered/src/credits.c:788 DoOverworldMapScrollScene
// Lua: credits.lua:318
function do_overworld_map_scroll_scene(): boolean {
  if (M.subseq === 0) {
    flags().setFlag(store(), null, FLAG_DONT_SHOW_MAP_NAME_POPUP, true);
    Map.disableMusicChange = Map.MUSIC_DISABLE_KEEP;
    M.ovwld = 0;
    M.subseq = 1;
  }
  // pokefirered/src/overworld.c:2384
  M.ovwld = M.ovwld + 1;
  if (M.ovwld === 3) {
    load_scene_map(M.whichMon);
  } else if (M.ovwld === 11) {
    // pokefirered/src/overworld.c:2481
    begin_fade(FIELD_PALS, 0, 16, 0, BLACK);
  } else if (M.ovwld === 13) {
    M.ovwld = 0;
    scroll_scene_ready();
    return true;
  }
  return false;
}

// pokefirered/src/credits.c:1101 DoCreditsMonScene
// Lua: credits.lua:342
function do_credits_mon_scene(): boolean {
  const mon = M.mon;
  const s = M.subseq;
  if (s === 0) {
    M.fade = null;
    destroy_player_or_rival();
    M.win0 = null;
    M.darken = false;
    const def = M.pack.mons[M.whichMon];
    const size = M.manifest.mons[M.whichMon];
    M.mon = {
      def,
      timer: 0,
      shown: 0,
      circleScale: 0,
      showCircle: false,
      showWindows: false,
      showBall: false,
      ball: image("pokeball_" + tostring(M.whichMon), 240, 160),
      frames: seq(
        image("mon_" + tostring(M.whichMon) + "_1", size.frame1.w, size.frame1.h),
        image("mon_" + tostring(M.whichMon) + "_2", size.frame2.w, size.frame2.h),
      ),
    };
    set_level("screen", 16);
    M.subseq = 1;
  } else if (s === 1) {
    mon.shown = 0;
    M.subseq = 2;
  } else if (s === 2) {
    mon.showCircle = true;
    mon.showWindows = true;
    begin_fade(ALL, 0, 16, 0, BLACK);
    mon.timer = 40;
    M.subseq = 3;
  } else if (s === 3) {
    if (mon.timer !== 0) {
      mon.timer = mon.timer - 1;
    } else {
      M.subseq = 4;
    }
  } else if (s === 4) {
    if (!fade_active()) {
      mon.timer = 8;
      mon.next = 1;
      M.subseq = 5;
    }
  } else if (s === 5) {
    if (mon.timer !== 0) {
      mon.timer = mon.timer - 1;
    } else if (mon.next < 3) {
      mon.shown = mon.next;
      mon.timer = 4;
      mon.next = mon.next + 1;
    } else {
      M.subseq = 6;
    }
  } else if (s === 6) {
    if (mon.timer < 256) {
      mon.timer = mon.timer + 16;
      mon.circleScale = mon.timer;
    } else {
      mon.circleScale = 0x100;
      mon.timer = 32;
      M.subseq = 7;
    }
  } else if (s === 7) {
    if (mon.timer !== 0) {
      mon.timer = mon.timer - 1;
    } else {
      mon.showCircle = false;
      mon.showBall = true;
      try { Audio.playCry(mon.def.species); } catch { /* pcall */ }
      mon.timer = 128;
      M.subseq = 8;
    }
  } else if (s === 8) {
    if (mon.timer !== 0) {
      mon.timer = mon.timer - 1;
    } else {
      begin_fade(ALL, 0, 0, 16, BLACK);
      M.subseq = 9;
    }
  } else if (s === 9) {
    if (!fade_active()) {
      M.subseq = 0;
      M.mon = null;
      return true;
    }
  }
  return false;
}

// pokefirered/src/credits.c:1230 DoCopyrightOrTheEndGfxScene
// Lua: credits.lua:436
function do_copyright_or_the_end_gfx_scene(): boolean {
  const s = M.subseq;
  if (s === 0) {
    M.fade = null;
    destroy_player_or_rival();
    M.win0 = null;
    M.darken = false;
    M.world = false;
    M.closing = { img: image(M.whichMon === 0 ? "copyright" : "the_end", 240, 160), shown: false };
    M.subseq = 1;
  } else if (s === 1) {
    M.subseq = 2;
  } else if (s === 2) {
    M.closing.shown = true;
    if (M.whichMon !== 0) {
      begin_fade(ALL, 0, 0, 0, BLACK);
    } else {
      begin_fade(ALL, 0, 16, 0, BLACK);
    }
    M.subseq = 3;
  } else if (s === 3) {
    if (!fade_active()) {
      M.subseq = 0;
      return true;
    }
  }
  return false;
}

// Lua: credits.lua:465
function cmd_at(i: number): any {
  return M.pack.script[i];
}

// pokefirered/src/credits.c:815 RollCredits
// Lua: credits.lua:470
function roll_credits(): number {
  const sq = M.mainseq;
  if (sq === SCENE.INIT_WIN0) {
    M.win0 = { top: 80 - 1, bottom: 80 + 1 };
    M.mainseq = SCENE.SETUP_DARKEN_EFFECT;
    return 0;
  } else if (sq === SCENE.SETUP_DARKEN_EFFECT) {
    M.darken = true;
    create_window();
    M.mainseq = SCENE.OPEN_WIN0;
    return 0;
  } else if (sq === SCENE.OPEN_WIN0) {
    if (M.win0.top === 0x24) {
      M.timer = 0;
      M.mainseq = SCENE.LOAD_PLAYER_SPRITE_AT_INDIGO;
    } else {
      M.win0.top = M.win0.top - 1;
      M.win0.bottom = M.win0.bottom + 1;
    }
    return 0;
  } else if (sq === SCENE.LOAD_PLAYER_SPRITE_AT_INDIGO) {
    if (M.timer !== 0) {
      M.timer = M.timer - 1;
      return 0;
    }
    load_player_or_rival(0);
    M.timer = 100;
    M.mainseq = SCENE.PRINT_TITLE_STAFF;
    return 0;
  } else if (sq === SCENE.PRINT_TITLE_STAFF) {
    if (M.timer !== 0) {
      M.timer = M.timer - 1;
      return 0;
    }
    M.timer = 360;
    // pokefirered/src/credits.c:868
    M.text = { staff: true, title: M.pack.title };
    M.mainseq = SCENE.WAIT_TITLE_STAFF;
    return 0;
  } else if (sq === SCENE.WAIT_TITLE_STAFF) {
    if (M.timer !== 0) {
      M.timer = M.timer - 1;
      return 0;
    }
    destroy_window();
    M.mainseq = SCENE.EXEC_CMD;
    M.timer = 0;
    M.scrcmdidx = 1;
    return 0;
  } else if (sq === SCENE.EXEC_CMD) {
    if (M.timer !== 0) {
      M.timer = M.timer - 1;
      return M.canSpeedThrough;
    }
    const c = cmd_at(M.scrcmdidx);
    if (!c) {
      M.mainseq = SCENE.TERMINATE;
      return 0;
    }
    if (c.cmd === CMD_PRINT) {
      begin_fade(TEXT_PAL, 0, 0, 16, BLACK);
      M.mainseq = SCENE.PRINT_ADDPRINTER1;
      M.text = null;
      return M.canSpeedThrough;
    } else if (c.cmd === CMD_MAPNEXT) {
      M.mainseq = SCENE.MAPNEXT_DESTROYWINDOW;
      M.whichMon = c.param;
      // pokefirered/src/credits.c:898
      begin_fade(FIELD_PALS, 0, 0, 16, BLACK);
    } else if (c.cmd === CMD_MAP) {
      M.mainseq = SCENE.MAP_LOADMAP_CREATESPRITES;
      M.whichMon = c.param;
    } else if (c.cmd === CMD_MON) {
      M.mainseq = SCENE.MON_DESTROY_ASSETS;
      M.whichMon = c.param;
      // pokefirered/src/credits.c:907
      begin_fade(ALL, 0, 0, 16, BLACK);
    } else if (c.cmd === CMD_THEENDGFX) {
      M.mainseq = SCENE.THEEND_DESTROY_ASSETS;
      M.whichMon = c.param;
      begin_fade(ALL, 4, 0, 16, BLACK);
    } else if (c.cmd === CMD_WAITBUTTON) {
      M.mainseq = SCENE.WAITBUTTON;
    }
    M.timer = c.duration;
    M.scrcmdidx = M.scrcmdidx + 1;
    return 0;
  } else if (sq === SCENE.PRINT_ADDPRINTER1) {
    if (fade_active()) return M.canSpeedThrough;
    const c = cmd_at(M.scrcmdidx);
    const t = M.pack.texts[c.param] || {};
    M.text = { title: t.title || "" };
    M.mainseq = SCENE.PRINT_ADDPRINTER2;
    return M.canSpeedThrough;
  } else if (sq === SCENE.PRINT_ADDPRINTER2) {
    const c = cmd_at(M.scrcmdidx);
    const t = M.pack.texts[c.param] || {};
    M.text.names = t.names || "";
    M.mainseq = SCENE.PRINT_DELAY;
    return M.canSpeedThrough;
  } else if (sq === SCENE.PRINT_DELAY) {
    const c = cmd_at(M.scrcmdidx);
    M.timer = c.duration;
    M.scrcmdidx = M.scrcmdidx + 1;
    begin_fade(TEXT_PAL, 0, 16, 0, BLACK);
    M.mainseq = SCENE.EXEC_CMD;
    return M.canSpeedThrough;
  } else if (sq === SCENE.MAPNEXT_DESTROYWINDOW) {
    if (!fade_active()) {
      destroy_window();
      M.subseq = 0;
      M.mainseq = SCENE.MAPNEXT_LOADMAP;
    }
    return 0;
  } else if (sq === SCENE.MAPNEXT_LOADMAP) {
    if (do_overworld_map_scroll_scene()) {
      M.canSpeedThrough = 1;
      M.mainseq = SCENE.EXEC_CMD;
    }
    return 0;
  } else if (sq === SCENE.MAP_LOADMAP_CREATESPRITES) {
    if (!fade_active()) {
      destroy_window();
      M.subseq = 0;
      M.world = true;
      set_level("screen", 0);
      while (!do_overworld_map_scroll_scene()) { /* run to the end */ }
      // pokefirered/src/credits.c:966
      const scene = ({ 3: 1, 6: 2, 9: 3, 12: 4 } as Record<number, number>)[M.whichMon] || 1;
      load_player_or_rival(scene);
      M.canSpeedThrough = 1;
      M.mainseq = SCENE.EXEC_CMD;
    }
    return 0;
  } else if (sq === SCENE.MON_DESTROY_ASSETS) {
    if (!fade_active()) {
      destroy_player_or_rival();
      destroy_window();
      M.subseq = 0;
      M.canSpeedThrough = 0;
      M.world = false;
      M.mainseq = SCENE.MON_SHOW;
    }
    return 0;
  } else if (sq === SCENE.MON_SHOW) {
    if (do_credits_mon_scene()) {
      M.mainseq = SCENE.EXEC_CMD;
    }
    return 0;
  } else if (sq === SCENE.THEEND_DESTROY_ASSETS) {
    if (!fade_active()) {
      destroy_window();
      M.subseq = 0;
      M.canSpeedThrough = 0;
      M.mainseq = SCENE.THEEND_SHOW;
    }
    return 0;
  } else if (sq === SCENE.THEEND_SHOW) {
    if (do_copyright_or_the_end_gfx_scene()) {
      M.mainseq = SCENE.EXEC_CMD;
    }
    return 0;
  } else if (sq === SCENE.WAITBUTTON) {
    if (M.aPressed) {
      begin_fade(ALL, 0, 0, 16, WHITE);
      M.mainseq = SCENE.TERMINATE;
      return 0;
    }
    if (M.timer !== 0) {
      M.timer = M.timer - 1;
    } else {
      M.mainseq = SCENE.TERMINATE;
      begin_fade(ALL, 0, 0, 16, WHITE);
    }
    return 0;
  } else if (sq === SCENE.TERMINATE) {
    if (!fade_active()) destroy_window();
  }
  return 2;
}

// pokefirered/src/credits.c:746
// Lua: credits.lua:708
function terminate(): void {
  Credits.open = false;
  Stack.pop(Credits.ID);
  flags().setFlag(store(), null, FLAG_DONT_SHOW_MAP_NAME_POPUP, false);
  Map.disableMusicChange = Map.MUSIC_DISABLE_OFF;
  FieldView.hideActors = false;
  FieldView.setCameraPanning(0, 0);
  M.done = true;
  const g = game();
  if (g) g.softResetRequested = true;
}

// Lua: credits.lua:756
function lerp_color(c: number[], level: Level): number[] {
  const a = (level.y || 0) / 16;
  const t = level.color || BLACK;
  return seq(c[1]! + (t[1]! - c[1]!) * a, c[2]! + (t[2]! - c[2]!) * a, c[3]! + (t[3]! - c[3]!) * a, 1) as number[];
}

// Lua: credits.lua:762
function print_block(text: unknown, x: number, y: number, fg: number, shadow: number, pitch: number): void {
  const colors: Colors = {
    fg: lerp_color(FrlgFont.STDPAL[fg]!, M.level.text),
    shadow: lerp_color(FrlgFont.STDPAL[shadow]!, M.level.text),
    bg: FrlgFont.STDPAL[0],
  };
  let line = 0;
  for (const [raw] of gmatch(tostring(text) + "\n", "(.-)\n")) {
    let lx = x, body = raw as string;
    // local clear, rest = raw:match(...)
    const caps = matchAll(raw as string, "^{CLEAR_TO (%d+)}(.*)$");
    if (caps) {
      lx = x + tonumber(caps[0])!;
      body = caps[1] as string;
    }
    if (body !== "") {
      FrlgFont.draw(body, WIN_X + lx, WIN_Y + y + line * pitch, { colors });
    }
    line = line + 1;
  }
}

// Lua: credits.lua:783
function with_band(fn: () => void): void {
  const w = M.win0;
  if (!w) return;
  const sc = G.getScissor();
  G.intersectScissor(0, w.top, 240, Math.max(0, w.bottom - w.top));
  fn();
  if (sc) G.setScissor(sc[0], sc[1], sc[2], sc[3]); else G.setScissor();
}

// Lua: credits.lua:792
function draw_sprite(entry: Entry | null, fw: number, fh: number, frame: number, cx: number, cy: number, level: Level): void {
  if (!entry) return;
  const k = 1 - level.y / 16;
  G.setColor(k, k, k, 1);
  G.draw(entry.image, quad_cache(entry, fw, fh, frame), cx - fw / 2, cy - fh / 2);
  G.setColor(1, 1, 1, 1);
}

// Lua: credits.lua:800
function draw_field_layer(): void {
  const R: any = Renderer;
  const wl = M.level.world;
  if (R) {
    R.worldFadeAlpha = wl.y / 16;
    R.worldFadeColor = wl.color;
  }
  // pokefirered/src/credits.c:762 InitBgDarkenEffect
  if (M.darken && M.win0) {
    G.setColor(0, 0, 0, 10 / 16);
    G.rectangle("fill", 0, M.win0.top, 240, M.win0.bottom - M.win0.top);
    G.setColor(1, 1, 1, 1);
  }
  with_band(() => {
    const t = M.text;
    if (t && M.windowActive) {
      if (t.staff) {
        print_block(t.title, 8, 0x29, HEADER_FG, HEADER_SHADOW, LINE_HEIGHT + 2);
      } else {
        print_block(t.title || "", 2, 6, HEADER_FG, HEADER_SHADOW, LINE_HEIGHT);
        if (t.names) print_block(t.names, 8, 6, REGULAR_FG, REGULAR_SHADOW, LINE_HEIGHT);
      }
    }
    const task = M.task;
    if (task) {
      const sl = M.level.sprite;
      const ground = image(task.ground, 64, 32 * 8);
      draw_sprite(ground, 64, 32, task.groundRunning ? task.gframe : 0, task.gx, task.gy, sl);
      draw_sprite(image(task.sheet, 64, 64 * 6), 64, 64, task.frame, task.x, task.y, sl);
    }
  });
}

// Lua: credits.lua:833
function screen_overlay(): void {
  const l = M.level.screen;
  if (l.y > 0) {
    G.setColor(l.color[1], l.color[2], l.color[3], l.y / 16);
    G.rectangle("fill", 0, 0, 240, 160);
    G.setColor(1, 1, 1, 1);
  }
}

// Lua: credits.lua:842
function draw_mon_scene(): void {
  const mon = M.mon;
  G.setColor(0, 0, 0, 1);
  G.rectangle("fill", 0, 0, 240, 160);
  G.setColor(1, 1, 1, 1);
  if (!mon) return;
  if (mon.showBall && mon.ball) {
    G.draw(mon.ball.image, 0, 0);
  }
  if (mon.showCircle) {
    const circle = image("circle", M.manifest.circle.w, M.manifest.circle.h);
    if (circle) {
      // pokefirered/src/credits.c:1126
      const s = mon.circleScale;
      if (s <= 0) {
        const [r, g, b, a] = circle.data.getPixel(circle.w / 2, circle.h / 2);
        G.setColor(r, g, b, a);
        G.rectangle("fill", 0, 0, 240, 160);
        G.setColor(1, 1, 1, 1);
      } else {
        const k = 256 / s;
        G.draw(circle.image, 0x78, 0x50, 0, k, k, circle.w / 2, circle.h / 2);
      }
    }
  }
  if (mon.showWindows) {
    const wins = mon.def.windows;
    if (mon.shown === 0) {
      const pic = Pokemon.frontPic(mon.def.species);
      if (pic && pic.image) {
        G.draw(pic.image, wins[1].left * 8, wins[1].top * 8);
      }
    } else {
      const f = mon.frames[mon.shown];
      const w = wins[mon.shown + 1];
      if (f && w) G.draw(f.image, w.left * 8, w.top * 8);
    }
  }
  screen_overlay();
}

export const Credits: CreditsModule = {
  ID: "credits",
  open: false,
  SCENE,
  CMD: {
    PRINT: CMD_PRINT, MAPNEXT: CMD_MAPNEXT, MAP: CMD_MAP, MON: CMD_MON,
    THEENDGFX: CMD_THEENDGFX, WAITBUTTON: CMD_WAITBUTTON,
  },

  // pokefirered/src/palette.c:393 UpdateNormalPaletteFade
  // Lua: credits.lua:127
  updateFade(): void {
    const f: Fade | null = M.fade;
    if (!(f && f.active)) return;
    if (f.finishing) {
      // pokefirered/src/palette.c:757
      if (f.fcount === 4) {
        f.active = false;
        f.finishing = false;
        f.fcount = 0;
      } else {
        f.fcount = f.fcount + 1;
      }
      return;
    }
    if (!f.toggle) {
      if (f.counter < f.delay) {
        f.counter = f.counter + 1;
        return;
      }
      f.counter = 0;
    }
    for (const [g] of pairs(f.groups)) {
      M.level[g] = { y: f.y, color: f.color };
    }
    f.toggle = !f.toggle;
    if (!f.toggle) {
      if (f.y === f.target) {
        f.finishing = true;
      } else if (f.y < f.target) {
        f.y = Math.min(f.target, f.y + 2);
      } else {
        f.y = Math.max(f.target, f.y - 2);
      }
    }
  },

  // Lua: credits.lua:651
  isOpen(): boolean {
    return Credits.open;
  },

  // Lua: credits.lua:655
  state(): any {
    if (!M) return null;
    const c = M.pack && M.pack.script[M.scrcmdidx - 1];
    return {
      mainseq: M.mainseq,
      subseq: M.subseq,
      scrcmdidx: M.scrcmdidx,
      lastCmd: c && c.cmd,
      whichMon: M.whichMon,
      text: M.text,
      textLevel: M.level.text.y,
      task: M.task,
      mon: M.mon,
      closing: M.closing,
      frames: M.frames,
      world: M.world,
    };
  },

  // Lua: credits.lua:674
  start(opts?: any): boolean {
    opts = opts || {};
    const pack = load_table("pack.lua");
    const manifest = load_table("manifest.lua");
    if (!(pack && manifest)) return false;
    images = {};
    M = {
      pack,
      manifest,
      mainseq: SCENE.INIT_WIN0,
      subseq: 0,
      timer: 0,
      scrcmdidx: 1,
      canSpeedThrough: 0,
      whichMon: 0,
      windowActive: false,
      parity: 0,
      frames: 0,
      world: true,
      darken: false,
      level: {
        world: { y: 0, color: BLACK }, text: { y: 0, color: BLACK },
        sprite: { y: 0, color: BLACK }, screen: { y: 0, color: BLACK },
      },
    };
    FieldView.hideActors = true;
    FieldView.setCameraPanning(0, 0);
    Credits.open = true;
    Stack.push(Credits.ID, Credits, { hideBelow: true });
    return true;
  },

  // Lua: credits.lua:722
  reset(): void {
    Credits.open = false;
    M = null;
    Map.disableMusicChange = Map.MUSIC_DISABLE_OFF;
    FieldView.hideActors = false;
    FieldView.setCameraPanning(0, 0);
  },

  // Lua: credits.lua:732
  update(_dt?: number): void {
    if (!(Credits.open && M)) return;
    M.frames = M.frames + 1;
    const r = roll_credits();
    M.aPressed = false;
    if (r === 2) {
      terminate();
      return;
    }
    run_tasks();
    animate_sprites();
    if (r === 1 && M.parity % 2 === 1) overworld_main_cb();
    Credits.updateFade();
    if (r === 1) M.parity = M.parity + 1;
  },

  // pokefirered/src/credits.c:1015
  // Lua: credits.lua:749
  handleInput(input: any): void {
    if (!(Credits.open && M && input)) return;
    if (M.mainseq === SCENE.WAITBUTTON && input.wasPressed("a")) {
      M.aPressed = true;
    }
  },

  // Lua: credits.lua:884
  draw(): void {
    if (!(Credits.open && M)) return;
    const R: any = Renderer;
    if (M.mainseq === SCENE.MON_SHOW) {
      if (R) { R.worldFadeAlpha = 1; R.worldFadeColor = BLACK; }
      draw_mon_scene();
      return;
    }
    if (M.closing) {
      if (R) { R.worldFadeAlpha = 1; R.worldFadeColor = BLACK; }
      G.setColor(0, 0, 0, 1);
      G.rectangle("fill", 0, 0, 240, 160);
      G.setColor(1, 1, 1, 1);
      if (M.closing.shown && M.closing.img) G.draw(M.closing.img.image, 0, 0);
      screen_overlay();
      return;
    }
    draw_field_layer();
  },
};

G3Lazy["src.ui.game3.credits"] = Credits;

export default Credits;
