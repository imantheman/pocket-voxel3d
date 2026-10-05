// Port of gen1recomp src/ui/game3/teachy_tv.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/teachy_tv.c:450 TeachyTvMainCallback
// The Teachy TV screen: the lesson list, the lesson scripts (host walk,
// grass, title / end cards, text pages), and the Pokédude bag / TM case demos.
//
// Port notes:
// - Lazily required: registers G3Lazy["src.ui.game3.teachy_tv"] at the end.
//   The module table is Brian's `Ui`.
// - pcall(require, "src.import.gba.extract_island1"): no port; its
//   CACHE_ROOT proxies onto CachePaths.CACHE_ROOT (extract_island1.lua:21).
// - pcall(require, "src.core.game3.dataset" / "src.import.CacheFs" /
//   "src.core.game3.audio" / "src.core.game3.ow_sprites"): all in the bundle;
//   love.filesystem is Fs, love.timer is Timer; love.image / love.graphics
//   are always present. math.random is platform/rng.ts's random.
// - NOT FAITHFUL: no io.open on the 3DS. read_bytes' last fallback
//   (io.open(rel)) is dropped; Fs.read already tried the same path.
// - Lua sequences keep slot 0 unused (GRASS_MAP, PROMPT_BOUNCE, GRASS_ANIM,
//   Ui.grass, the grass quads, the static grid); the static quads are keyed
//   0..3 (a JS array with slot 0 used).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { seq, len, ipairs, type LuaTable } from "../platform/lt.ts";
import { tonumber, tostring, mod } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { newImageData } from "../platform/image.ts";
import * as Fs from "../platform/fs.ts";
import { random } from "../platform/rng.ts";
import { Timer } from "../platform/timer.ts";
import { G3Lazy } from "../core/lazy_registry.ts";
import Stack from "./stack.ts";
import Window from "./window.ts";
import Chrome from "./chrome.ts";
import FrlgFont from "./frlg_font.ts";
import TeachyTv from "../core/teachy_tv.ts";
import SeIds from "../core/se_ids.ts";
import Song from "../core/song_ids.ts";
import Audio from "../core/audio.ts";
import Fade from "./fade.ts";
import CachePaths from "../core/cache_paths.ts";
import Dataset from "../core/dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import BagMenuMod from "./bag_menu.ts";
import ItemsData from "../core/items_data.ts";
import TmCaseMod from "./tm_case.ts";
import OwSpritesMod from "../core/ow_sprites.ts";
import Trig from "../core/trig.ts";
import BagChrome from "./bag_chrome.ts";

const BagMenu: any = BagMenuMod;
const TmCase: any = TmCaseMod;
const TTV: any = TeachyTv;

// pokefirered/src/teachy_tv.c:236 upText_Y
const ROW_PITCH = 16;
// pokefirered/src/teachy_tv.c:145 sWindowTemplates[1]
const LIST_TPL = { left: 4, top: 1, width: 22, height: 12 };
// pokefirered/src/teachy_tv.c:145 sWindowTemplates[0]
const BODY_TPL = { left: 2, top: 15, width: 26, height: 4 };

// (Brian's LIST_WIN / BODY_WIN templates; unused by his draw code, kept for parity)
const LIST_WIN = Window.template(LIST_TPL.left, LIST_TPL.top, LIST_TPL.width, LIST_TPL.height);
const BODY_WIN = Window.template(BODY_TPL.left, BODY_TPL.top, BODY_TPL.width, BODY_TPL.height);

// pokefirered/src/teachy_tv.c:679 AddTextPrinterParameterized2(0, FONT_MALE, text, speed, 0, 1, 0xC, 3)
const BODY_COLOR = { fg: FrlgFont.STDPAL[1], shadow: FrlgFont.STDPAL[3], bg: FrlgFont.STDPAL[0] };
// pokefirered/src/teachy_tv.c:237 cursorPal
const LIST_COLOR = FrlgFont.COLOR.WHITE;

// pokefirered/src/teachy_tv.c:620 TeachyTvSetWindowRegs
const WIN0_X0 = 0x1C, WIN0_X1 = 0xD4, WIN0_Y0 = 0x0C, WIN0_Y1 = 0x64;
// pokefirered/src/teachy_tv.c:601 SetGpuReg(REG_OFFSET_BLDY, 0x5)
const LIST_DARKEN = 5 / 16;
// pokefirered/src/teachy_tv.c:247 sScrollIndicatorArrowPair
const ARROW_X = 0x78, ARROW_UP_Y = 0x0C, ARROW_DOWN_Y = 0x64;

const LIST_CURSOR_OPTS = { colors: LIST_COLOR };
const LIST_TEXT_OPTS = { maxWidth: LIST_TPL.width * 8 - 8, colors: LIST_COLOR };
const BODY_TEXT_OPTS = { maxWidth: BODY_TPL.width * 8, linePitch: 16, colors: BODY_COLOR as any };

// pokefirered/src/text.c:471 TextPrinterDrawDownArrow
const PROMPT_BOUNCE: LuaTable = seq(0, 1, 2, 3, 2, 1);

// pokefirered/src/graphics.c:1117 gTeachyTv_Gfx
const CACHE_SUB = "teachy_tv";
const SCREEN_W = 240, SCREEN_H = 160;
const FRAME = 1 / 60;

// pokefirered/src/teachy_tv.c:519 ChangeBgX(3, 0x1000, 2), ChangeBgY(3, 0x2800, 1)
const BG3_X0 = -16, BG3_Y0 = 40;
// pokefirered/src/teachy_tv.c:1218 TeachyTvLoadBg3Map
const BG3_W = 256, BG3_H = 256;
// pokefirered/src/teachy_tv.c:632 TeachyTvBg2AnimController
const STATIC_LEFT = 2, STATIC_TOP = 1, STATIC_COLS = 26, STATIC_ROWS = 12;
// pokefirered/src/data/field_effects/field_effect_objects.h:73 sAnim_TallGrass
const GRASS_FRAME_TICKS = 10, GRASS_FRAMES = 5;
const GRASS_W = 16, GRASS_H = 16;

// pokefirered/src/teachy_tv.c:907 sGrassAnimArray
const GRASS_MAP: LuaTable = seq(
  0, 0, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 0, 0,
  0, 0, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 0, 0,
  0, 0, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 0, 0,
  0, 0, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 0, 0,
  0, 0, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 1, 1, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 1, 1, 0, 0,
);

// pokefirered/include/constants/songs.h:354 MUS_TEACHY_TV_MENU (Song = song_ids)

const T: any = TTV.TIMING;

// Lua: teachy_tv.lua:103
function se(id: any): void {
  try {
    const A: any = Audio;
    if (A && A.playSe) A.playSe(id);
  } catch { /* pcall */ }
}

// Lua: teachy_tv.lua:111
// pokefirered/src/sound.c:129 PlayNewMapMusic
function song(id: any): void {
  Audio.playSong(id);
}

// Lua: teachy_tv.lua:116
function fade(): typeof Fade {
  return Fade;
}

// Lua: teachy_tv.lua:120
function read_bytes(rel: string): string | undefined {
  // pcall(require, "src.core.game3.dataset")
  if (Dataset && Dataset.cache) {
    let d: any;
    try { d = Dataset.cache().read(rel); } catch { d = undefined; }
    if (typeof d === "string" && d.length > 0) return d;
  }
  // pcall(require, "src.import.CacheFs")
  if (CacheFs && CacheFs.readActive) {
    let d: any;
    try { d = CacheFs.readActive(rel); } catch { d = undefined; }
    if (typeof d === "string" && d.length > 0) return d;
  }
  {
    let d: any;
    try { d = Fs.read(rel); } catch { d = undefined; }
    if (typeof d === "string" && d.length > 0) return d;
  }
  // NOT FAITHFUL: no io.open on the 3DS (see the port notes).
  return undefined;
}

// Lua: teachy_tv.lua:144
function cache_root(): string {
  // (okE and Extract and Extract.CACHE_ROOT) or "data/generated/gba"
  return CachePaths.CACHE_ROOT || "data/generated/gba";
}

// Lua: teachy_tv.lua:149
function rgba_to_image(rgba: string | undefined, w: number, h: number): any {
  // `love and love.image and love.graphics`: always present here
  if (!rgba || rgba.length < w * h * 4) return undefined;
  let data: any;
  try { data = newImageData(w, h, "rgba8", rgba); } catch { return undefined; }
  if (!data) return undefined;
  let img: any;
  try { img = G.newImage(data); } catch { return undefined; }
  if (img.setFilter) img.setFilter("nearest", "nearest");
  return img;
}

// Lua: teachy_tv.lua:166
function art(name: string, w?: number, h?: number): any {
  if (Ui._images[name] == null) {
    const bytes = read_bytes(Ui.artPath(name));
    Ui._images[name] = (bytes ? rgba_to_image(bytes, w ?? SCREEN_W, h ?? SCREEN_H) : undefined) || false;
    if (name === "screen") {
      // pokefirered/src/teachy_tv.c:530 LZDecompressWram(gTeachyTvScreen_Tilemap, ...)
      const at = ((SCREEN_H / 2) * SCREEN_W + SCREEN_W / 2) * 4 + 4;
      Ui._chromeCutOut = (Ui._images[name] && bytes!.length >= at && bytes!.charCodeAt(at - 1) === 0) || false;
    }
  }
  return Ui._images[name] || undefined;
}

// Lua: teachy_tv.lua:180
// pokefirered/src/data/field_effects/field_effect_objects.h:88 gFieldEffectObjectTemplate_TallGrass
function grass_sheet(): any {
  if (Ui._grassSheet == null) {
    const rel = cache_root() + "/field_effects/tall_grass.rgba";
    const bytes = read_bytes(rel);
    const img = bytes ? rgba_to_image(bytes, GRASS_W, GRASS_H * GRASS_FRAMES) : undefined;
    if (img) {
      const quads: LuaTable = seq<any>();
      for (let i = 1; i <= GRASS_FRAMES; i++) {
        quads[i] = G.newQuad(0, (i - 1) * GRASS_H, GRASS_W, GRASS_H,
          GRASS_W, GRASS_H * GRASS_FRAMES);
      }
      Ui._grassSheet = { image: img, quads };
    } else {
      Ui._grassSheet = false;
    }
  }
  return Ui._grassSheet || undefined;
}

// Lua: teachy_tv.lua:217
function maxShowed(): number {
  return TTV.maxShowed(Ui._session, Ui._bag);
}

// Lua: teachy_tv.lua:221
function clamp_cursor(): void {
  let total = len(Ui.rows());
  if (total < 1) total = 1;
  if (Ui.cursor > total) Ui.cursor = total;
  if (Ui.cursor < 1) Ui.cursor = 1;
  const shown = maxShowed();
  if (Ui.cursor <= Ui.scroll) Ui.scroll = Ui.cursor - 1;
  if (Ui.cursor > Ui.scroll + shown) Ui.scroll = Ui.cursor - shown;
  if (Ui.scroll < 0) Ui.scroll = 0;
}

// Lua: teachy_tv.lua:233
// pokefirered/src/teachy_tv.c:713 TeachyTvOptionListController
function sync_resources(): void {
  const res = TTV.resources(Ui._session);
  if (!res) return;
  res.scrollOffset = Ui.scroll;
  res.selectedRow = Ui.cursor - 1 - Ui.scroll;
  if (res.selectedRow < 0) res.selectedRow = 0;
}

// Lua: teachy_tv.lua:255
// pokefirered/src/teachy_tv.c:1140 TeachyTvGrassAnimationMain
function grass_spawn(x: number, y: number, seekEnd?: boolean): void {
  if (!Ui.grassAt(x - 0x10, y)) return;
  Ui.grass[len(Ui.grass) + 1] = {
    x,
    y: y + 8,
    // pokefirered/src/teachy_tv.c:1120 SeekSpriteAnim(obj, 4)
    frames: seekEnd ? (GRASS_FRAME_TICKS * 4) : 0,
    split: !seekEnd,
  };
}

// pokefirered/src/data/field_effects/field_effect_objects.h:73 sAnim_TallGrass
const GRASS_ANIM: LuaTable = seq(1, 2, 3, 4, 0);

// Lua: teachy_tv.lua:280
// pokefirered/src/teachy_tv.c:1122 TeachyTvGrassAnimationObjCallback
function grass_step(): void {
  if (len(Ui.grass) === 0) return;
  const keep: LuaTable = seq<any>();
  const hx = Ui.hostX ?? 0, hy = Ui.hostY ?? 0;
  for (const [, g] of ipairs<any>(Ui.grass)) {
    g.x = g.x + Ui.grassDx;
    g.y = g.y + Ui.grassDy;
    g.frames = g.frames + 1;
    let alive = true;
    if (g.frames >= GRASS_FRAME_TICKS * GRASS_FRAMES) {
      const dx = g.x - hx, dy = g.y - hy;
      if (dx <= -16 || dx >= 16 || dy <= -16 || dy >= 24) alive = false;
    }
    if (alive) keep[len(keep) + 1] = g;
  }
  Ui.grass = keep;
}

// Lua: teachy_tv.lua:299
// pokefirered/src/teachy_tv.c:632 TeachyTvBg2AnimController
function bg2_anim(): void {
  let grid = Ui.static;
  if (!grid) {
    grid = seq<number>();
    Ui.static = grid;
  }
  for (let i = 1; i <= STATIC_ROWS * STATIC_COLS; i++) {
    grid[i] = random(0, 3);
  }
}

// Lua: teachy_tv.lua:311
// pokefirered/src/teachy_tv.c:1059 ChangeBgX(3, 0x0, 0)
function reset_bg3(): void {
  Ui.bg3X = BG3_X0;
  Ui.bg3Y = BG3_Y0;
  Ui.grassLo = 0;
  Ui.grassHi = 3;
  Ui.grass = seq<any>();
  Ui.grassDx = 0;
  Ui.grassDy = 0;
}

// Lua: teachy_tv.lua:322
// pokefirered/src/teachy_tv.c:1043 TTVcmd_End
function to_list(): void {
  Ui.state = "list";
  Ui.page = 1;
  Ui.phase = "intro";
  Ui._pages = undefined;
  Ui.step = 1;
  Ui.frames = 0;
  Ui.suspended = false;
  Ui.title = false;
  Ui.endCard = false;
  Ui.hostVisible = false;
  reset_bg3();
  Ui._rows = TTV.menuItems(Ui._session, Ui._bag);
  clamp_cursor();
  sync_resources();
}

// Lua: teachy_tv.lua:390
function set_printer(phase: string, pages: any): void {
  Ui.phase = phase;
  Ui._pages = pages ?? seq();
  Ui.page = 1;
}

// Lua: teachy_tv.lua:402
function step_advance(): void {
  Ui.step = Ui.step + 1;
  Ui.frames = 0;
}

// Lua: teachy_tv.lua:408
// pokefirered/src/teachy_tv.c:612 TeachyTvSetSpriteCoordsAndSwitchFrame
function host(x: number | undefined, y: number | undefined, facing: string | undefined, walking: boolean): void {
  if (x != null) Ui.hostX = x;
  if (y != null) Ui.hostY = y;
  Ui.hostFacing = facing ?? Ui.hostFacing ?? "down";
  Ui.hostWalk = walking ? true : false;
  Ui.hostVisible = true;
}

const STEP: Record<string, () => void> = {};

// Lua: teachy_tv.lua:419
// pokefirered/src/teachy_tv.c:755 TTVcmd_TransitionRenderBg2TeachyTvGraphicInitNpcPos
STEP.transition_render_bg2 = () => {
  // pokefirered/src/teachy_tv.c:758 TeachyTvBg2AnimController
  bg2_anim();
  if (Ui.frames > T.TITLE - 1) {
    // pokefirered/src/teachy_tv.c:761 CopyToBgTilemapBufferRect_ChangePalette
    Ui.static = undefined;
    Ui.title = true;
    host(T.DUDE_X_START, T.DUDE_Y, "right", true);
    song(Song.MUS_FOLLOW_ME);
    step_advance();
  }
};

// Lua: teachy_tv.lua:433
// pokefirered/src/teachy_tv.c:770 TTVcmd_ClearBg2TeachyTvGraphic
STEP.clear_bg2 = () => {
  if (Ui.frames === T.CLEAR) {
    Ui.title = false;
    step_advance();
  }
};

// Lua: teachy_tv.lua:441
// pokefirered/src/teachy_tv.c:782 TTVcmd_NpcMoveAndSetupTextPrinter
STEP.npc_move_and_setup_text_printer = () => {
  if (Ui.frames <= T.NPC_WAIT) return;
  if ((Ui.hostX ?? 0) < T.DUDE_X_END) {
    Ui.hostX = (Ui.hostX ?? T.DUDE_X_START) + 1;
    Ui.hostStep = mod(Ui.hostX!, 16) < 8;
    return;
  }
  host(undefined, undefined, "down", false);
  set_printer("hello", TTV.pagesOf(TTV.HELLO));
  step_advance();
};

// Lua: teachy_tv.lua:454
// pokefirered/src/teachy_tv.c:801 TTVcmd_IdleIfTextPrinterIsActive
STEP.idle_if_text_printer_active = () => {
  if (!Ui.printerActive()) step_advance();
};
STEP.idle_if_text_printer_active2 = STEP.idle_if_text_printer_active;

// Lua: teachy_tv.lua:460
// pokefirered/src/teachy_tv.c:838 TTVcmd_TextPrinterSwitchStringByOptionChosen
STEP.text_printer_intro = () => {
  set_printer("intro", TTV.introPages(TTV.whichScript(Ui._session)));
  step_advance();
};

// Lua: teachy_tv.lua:466
// pokefirered/src/teachy_tv.c:853 TTVcmd_TextPrinterSwitchStringByOptionChosen2
STEP.text_printer_outro = () => {
  set_printer("outro", TTV.outroPages(TTV.whichScript(Ui._session)));
  step_advance();
};

// Lua: teachy_tv.lua:472
// pokefirered/src/teachy_tv.c:936 TTVcmd_EraseTextWindowIfKeyPressed
STEP.erase_text_window_if_key_pressed = () => {
};

// Lua: teachy_tv.lua:476
// pokefirered/src/teachy_tv.c:947 TTVcmd_StartAnimNpcWalkIntoGrass
STEP.start_anim_npc_walk_into_grass = () => {
  host(undefined, undefined, "up", true);
  Ui.grassDx = 0;
  Ui.grassDy = 1;
  step_advance();
};

// Lua: teachy_tv.lua:484
// pokefirered/src/teachy_tv.c:957 TTVcmd_DudeMoveUp
STEP.dude_move_up = () => {
  // pokefirered/src/teachy_tv.c:961 ChangeBgY(3, 0x100, 2)
  Ui.bg3Y = Ui.bg3Y - 1;
  Ui.hostStep = mod(Ui.frames, 16) < 8;
  if (mod(Ui.frames, 16) === 0) {
    Ui.grassHi = Ui.grassHi - 1;
    grass_spawn(Ui.hostX ?? 0, Ui.hostY ?? 0);
  }
  if (Ui.frames === T.MOVE_UP) {
    Ui.grassDx = -1;
    Ui.grassDy = 0;
    host(undefined, undefined, "right", true);
    step_advance();
  }
};

// Lua: teachy_tv.lua:501
// pokefirered/src/teachy_tv.c:977 TTVcmd_DudeMoveRight
STEP.dude_move_right = () => {
  // pokefirered/src/teachy_tv.c:981 ChangeBgX(3, 0x100, 1)
  Ui.bg3X = Ui.bg3X + 1;
  Ui.hostStep = mod(Ui.frames, 16) < 8;
  if (mod(Ui.frames, 16) === 0) Ui.grassLo = Ui.grassLo + 1;
  if (mod(Ui.frames + 8, 16) === 0) {
    grass_spawn((Ui.hostX ?? 0) + 8, Ui.hostY ?? 0);
  }
  if (Ui.frames === T.MOVE_RIGHT) {
    Ui.grassDx = 0;
    Ui.grassDy = 0;
    host(undefined, undefined, "right", false);
    step_advance();
  }
};

// Lua: teachy_tv.lua:518
// pokefirered/src/teachy_tv.c:1069 TTVcmd_TaskBattleOrFadeByOptionChosen
STEP.battle_or_fade = () => {
  const script = TTV.whichScript(Ui._session);
  if (TTV.endsInBattle(script)) {
    Ui.suspended = true;
    const started = TTV.startDemonstration(Ui._session, script, {
      transition: TTV.battleTransition(script),
      resumeStep: TTV.RESUME_STEP[script],
      bag: Ui._bag,
      onDone: Ui.resumeFromDemonstration,
    });
    if (!started) {
      Ui.suspended = false;
      Ui.resumeFromDemonstration(undefined);
    }
    return;
  }
  Ui.openPokedudeBag(script);
};

// Lua: teachy_tv.lua:538
// pokefirered/src/teachy_tv.c:996 TTVcmd_DudeTurnLeft
STEP.dude_turn_left = () => {
  host(undefined, undefined, "left", false);
  Ui.grassDx = 0;
  Ui.grassDy = 0;
  grass_spawn(Ui.hostX ?? 0, Ui.hostY ?? 0);
  step_advance();
};

// Lua: teachy_tv.lua:547
// pokefirered/src/teachy_tv.c:1008 TTVcmd_DudeMoveLeft
STEP.dude_move_left = () => {
  if (mod(Ui.hostX ?? 0, 16) === 0) {
    grass_spawn((Ui.hostX ?? 0) - 8, Ui.hostY ?? 0);
  }
  if ((Ui.hostX ?? 0) <= T.DUDE_X_START) {
    step_advance();
    return;
  }
  Ui.hostX = Ui.hostX! - 1;
  host(undefined, undefined, "left", true);
  Ui.hostStep = mod(Ui.hostX, 16) < 8;
};

// Lua: teachy_tv.lua:561
// pokefirered/src/teachy_tv.c:1021 TTVcmd_RenderAndRemoveBg1EndGraphic
STEP.render_and_remove_bg1_end_graphic = () => {
  Ui.endCard = true;
  if (Ui.frames > T.END_GRAPHIC - 1) {
    Ui.endCard = false;
    step_advance();
  }
};

// Lua: teachy_tv.lua:570
// pokefirered/src/teachy_tv.c:1043 TTVcmd_End
STEP["end"] = () => {
  if (Ui.frames === 1) {
    song(Song.MUS_TEACHY_TV_MENU);
    Ui.hostVisible = false;
  }
  // pokefirered/src/teachy_tv.c:1048 TeachyTvBg2AnimController
  bg2_anim();
  if (Ui.frames > T.END - 1) {
    if (!Ui.aborted) {
      TTV.markWatched(Ui._session, TTV.whichScript(Ui._session));
    }
    to_list();
  }
};

// Lua: teachy_tv.lua:586
// pokefirered/src/teachy_tv.c:808 TeachyTvRenderMsgAndSwitchClusterFuncs
function abort_to_end(): void {
  const cluster = TTV.STEPS[TTV.whichScript(Ui._session)] ?? seq();
  Ui.aborted = true;
  Ui.hostVisible = false;
  // pokefirered/src/teachy_tv.c:813 grassAnimDisabled = 1
  Ui.grass = seq<any>();
  Ui._pages = undefined;
  Ui.title = false;
  Ui.endCard = false;
  Ui.step = len(cluster);
  Ui.frames = 0;
}

// Lua: teachy_tv.lua:600
// pokefirered/src/teachy_tv.c:713 TeachyTvOptionListController
function begin_lesson(scriptId: any): void {
  TTV.selectLesson(Ui._session, scriptId);
  Ui.state = "lesson";
  Ui.phase = "intro";
  Ui.page = 1;
  Ui._pages = undefined;
  Ui.step = 1;
  Ui.frames = 0;
  Ui.title = false;
  Ui.endCard = false;
  Ui.aborted = false;
  Ui.hostVisible = false;
}

// Lua: teachy_tv.lua:697
const NO_INPUT = {
  wasPressed: (_k?: string): boolean => false,
  isDown: (_k?: string): boolean => false,
};

// Lua: teachy_tv.lua:702
function press_input(key: string): any {
  return {
    wasPressed: (k: string): boolean => k === key,
    isDown: (): boolean => false,
  };
}

// Lua: teachy_tv.lua:710
// pokefirered/src/item_menu.c:2069 gBagMenuState.pocket / itemsAbove / cursorPos
function snapshot_bag_positions(session: any, bag: any): any {
  const saved: any = { pos: {} };
  BagMenu.show(bag, { session });
  saved.pocket = BagMenu.pocketIdx;
  for (let i = 1; i <= len(ItemsData.BAG_POCKET_ORDER); i++) {
    BagMenu.show(bag, { session, pocketIdx: i });
    saved.pos[i] = { cursor: BagMenu.cursor, scroll: BagMenu.scroll };
  }
  return saved;
}

// Lua: teachy_tv.lua:724
// pokefirered/src/item_menu.c:2089 gBagMenuState.pocket = sBackupPlayerBag->pocket
function apply_bag_positions(session: any, bag: any, saved: any): void {
  const last = (saved ? tonumber(saved.pocket) : undefined) ?? 1;
  const order: LuaTable = seq<number>();
  for (let i = 1; i <= len(ItemsData.BAG_POCKET_ORDER); i++) {
    if (i !== last) order[len(order) + 1] = i;
  }
  order[len(order) + 1] = last;
  for (const [, i] of ipairs<number>(order)) {
    const p = saved ? saved.pos[i] : undefined;
    BagMenu.show(bag, { session, pocketIdx: i });
    BagMenu.cursor = (p ? p.cursor : undefined) ?? 1;
    BagMenu.scroll = (p ? p.scroll : undefined) ?? 0;
    BagMenu.close();
  }
}

const BagDemo: any = {
  // Lua: teachy_tv.lua:746
  // pokefirered/src/item_menu.c:2208 Task_Bag_TeachyTvRegister
  tick(): void {
    if (BagDemo.finished || !BagMenu.isOpen()) return;
    BagDemo.frames = (BagDemo.frames ?? 0) + 1;
    const entry = BagDemo.plan ? BagDemo.plan[BagDemo.index] : undefined;
    if (entry && BagDemo.frames === entry.at) {
      BagDemo.index = BagDemo.index + 1;
      if (entry.item != null) {
        // pokefirered/src/item_menu.c:2223 gSpecialVar_ItemId
        for (const [i, row] of ipairs<any>((BagMenu.list ? BagMenu.list() : undefined) ?? seq())) {
          if (ItemsData.toNumericId(row.id) === entry.item) {
            BagMenu.cursor = i;
            break;
          }
        }
      }
      if (entry.exit) {
        // pokefirered/src/item_menu.c:2254 Bag_BeginCloseWin0Animation
        BagDemo.finished = true;
        BagDemo.toTmCase = entry.tmCase ? true : false;
        BagMenu.close();
        return;
      }
      BagMenu.handleInput(press_input(entry.key));
      return;
    }
    BagMenu.handleInput(NO_INPUT);
  },

  // Lua: teachy_tv.lua:776
  update(dt: any): void {
    BagDemo._acc = (BagDemo._acc ?? 0) + (tonumber(dt) ?? 0);
    let n = 0;
    while (BagDemo._acc >= FRAME && n < 8) {
      BagDemo._acc = BagDemo._acc - FRAME;
      n = n + 1;
      BagDemo.tick();
    }
    if (BagDemo._acc > FRAME) BagDemo._acc = 0;
  },

  // Lua: teachy_tv.lua:788
  // pokefirered/src/item_menu.c:2192 Task_BButtonInterruptTeachyTv
  handleInput(input: any): void {
    if (!input || BagDemo.finished) return;
    if (input.wasPressed("b")) {
      BagDemo.interrupted = true;
      BagDemo.finished = true;
      se(SeIds.SE_SELECT);
      BagMenu.close();
    }
  },

  // Lua: teachy_tv.lua:799
  draw(): void {
  },
};

// pokefirered/src/data/text/teachy_tv.h:142 gPokedudeText_TMTypes
const TM_TEXT: Record<string, any> = {
  TM_TYPES: TTV.TM_TYPES,
  TM_DESCRIPTION: TTV.TM_DESCRIPTION,
};

// Lua: teachy_tv.lua:811
function tm_enter(index: number): void {
  TmDemo.index = index;
  TmDemo.frames = 0;
  const entry = TmDemo.plan ? TmDemo.plan[index] : undefined;
  if (!entry) return;
  if (entry.exit) {
    TmDemo.finished = true;
    TmCase.close();
    return;
  }
  if (entry.text) {
    // pokefirered/src/tm_case.c:1420 PrintMessageWithFollowupTask
    TmDemo.pages = TTV.pagesOf(TM_TEXT[entry.text]);
    TmDemo.page = 1;
    TmCase.mode = "message";
    TmCase.messageText = TmDemo.pages[1];
    return;
  }
  if (entry.key) TmCase.handleInput(press_input(entry.key));
}

const TmDemo: any = {
  // Lua: teachy_tv.lua:834
  // pokefirered/src/tm_case.c:1353 Task_Pokedude_Run
  tick(): void {
    if (TmDemo.finished || !TmCase.isOpen()) return;
    const entry = TmDemo.plan ? TmDemo.plan[TmDemo.index] : undefined;
    if (!entry || entry.text) return;
    TmDemo.frames = TmDemo.frames + 1;
    // pokefirered/src/tm_case.c:1377 tPokedudeTimer > POKEDUDE_INPUT_DELAY
    if (TmDemo.frames >= TTV.POKEDUDE_INPUT_DELAY) {
      tm_enter(TmDemo.index + 1);
    }
  },

  // Lua: teachy_tv.lua:846
  update(dt: any): void {
    TmDemo._acc = (TmDemo._acc ?? 0) + (tonumber(dt) ?? 0);
    let n = 0;
    while (TmDemo._acc >= FRAME && n < 8) {
      TmDemo._acc = TmDemo._acc - FRAME;
      n = n + 1;
      TmDemo.tick();
    }
    if (TmDemo._acc > FRAME) TmDemo._acc = 0;
  },

  // Lua: teachy_tv.lua:857
  handleInput(input: any): void {
    if (!input || TmDemo.finished) return;
    // pokefirered/src/tm_case.c:1357 JOY_NEW(B_BUTTON), tPokedudeState = 21
    if (input.wasPressed("b")) {
      TmDemo.interrupted = true;
      TmDemo.finished = true;
      se(SeIds.SE_SELECT);
      TmCase.close();
      return;
    }
    const entry = TmDemo.plan ? TmDemo.plan[TmDemo.index] : undefined;
    if (entry && entry.text && input.wasPressed("a")) {
      // pokefirered/src/tm_case.c:1434 JOY_NEW(A_BUTTON | B_BUTTON)
      se(SeIds.SE_SELECT);
      if (TmDemo.page < len(TmDemo.pages ?? seq())) {
        TmDemo.page = TmDemo.page + 1;
        TmCase.messageText = TmDemo.pages[TmDemo.page];
      } else {
        TmCase.mode = "list";
        TmCase.messageText = undefined;
        tm_enter(TmDemo.index + 1);
      }
    }
  },

  // Lua: teachy_tv.lua:883
  draw(): void {
  },
};

// Lua: teachy_tv.lua:1080
function static_quads(): any[] | undefined {
  if (Ui._staticQuads == null) {
    if (Ui.staticArt()) {
      const q: any[] = [];
      for (let i = 0; i <= 3; i++) q[i] = G.newQuad(i * 8, 0, 8, 8, 32, 8);
      Ui._staticQuads = q;
    } else {
      Ui._staticQuads = false;
    }
  }
  return Ui._staticQuads || undefined;
}

let OwSprites: any = undefined;
// Lua: teachy_tv.lua:1094
function ow_sprites(): any {
  if (OwSprites == null) {
    // pcall(require, "src.core.game3.ow_sprites")
    const m: any = OwSpritesMod;
    OwSprites = (m != null && typeof m === "object" && m.draw && m) || false;
  }
  return OwSprites || undefined;
}

// Lua: teachy_tv.lua:1103
// pokefirered/src/teachy_tv.c:606 CreateObjectGraphicsSprite
function draw_host(): void {
  if (!Ui.hostVisible) return;
  const sprites = ow_sprites();
  if (!sprites) return;
  try {
    sprites.draw(TTV.HOST_GFX,
      (Ui.hostX ?? T.DUDE_X_END) - 8, Ui.hostY ?? T.DUDE_Y, 0, 0,
      Ui.hostFacing ?? "down", Ui.hostWalk ? 1 : 0, Ui.hostStep ? true : false);
  } catch { /* pcall */ }
}

// Lua: teachy_tv.lua:1113
// pokefirered/src/teachy_tv.c:526 TeachyTvLoadGraphic
function draw_chrome(): void {
  const bg = Ui.chrome();
  if (!bg) return;
  G.setColor(1, 1, 1, 1);
  G.draw(bg, 0, 0);
}

// Lua: teachy_tv.lua:1121
// pokefirered/src/teachy_tv.c:519 ChangeBgX(3, 0x1000, 2)
function draw_bg3(): void {
  const map = Ui.bg3Art();
  if (!map) return;
  const ox = -mod(Ui.bg3X, BG3_W);
  const oy = -mod(Ui.bg3Y, BG3_H);
  G.setColor(1, 1, 1, 1);
  for (let dx = 0; dx <= 1; dx++) {
    for (let dy = 0; dy <= 1; dy++) {
      G.draw(map, ox + dx * BG3_W, oy + dy * BG3_H);
    }
  }
}

// Lua: teachy_tv.lua:1135
// pokefirered/src/teachy_tv.c:632 TeachyTvBg2AnimController
function draw_static(): void {
  const grid = Ui.static;
  const tile = grid ? Ui.staticArt() : undefined;
  const quads = tile ? static_quads() : undefined;
  if (!quads) return;
  G.setColor(1, 1, 1, 1);
  for (let row = 0; row <= STATIC_ROWS - 1; row++) {
    for (let col = 0; col <= STATIC_COLS - 1; col++) {
      const pal = grid![row * STATIC_COLS + col + 1];
      if (pal != null && quads[pal]) {
        G.draw(tile, quads[pal], (STATIC_LEFT + col) * 8, (STATIC_TOP + row) * 8);
      }
    }
  }
}

// Lua: teachy_tv.lua:1152
// pokefirered/src/teachy_tv.c:875 sSubspriteArray
function grass_half_quad(sheet: any, frame: number, bottom: boolean): any {
  sheet.halves = sheet.halves ?? {};
  const key = frame * 2 + (bottom ? 1 : 0);
  let q = sheet.halves[key];
  if (!q) {
    q = G.newQuad(0, frame * GRASS_H + (bottom ? 8 : 0), GRASS_W, 8,
      GRASS_W, GRASS_H * GRASS_FRAMES);
    sheet.halves[key] = q;
  }
  return q;
}

// Lua: teachy_tv.lua:1165
// pokefirered/src/teachy_tv.c:1132 TeachyTvGrassAnimationObjCallback
function draw_grass(behindHost: boolean): void {
  if (len(Ui.grass) === 0) return;
  const sheet = grass_sheet();
  if (!sheet) return;
  G.setColor(1, 1, 1, 1);
  for (const [, g] of ipairs<any>(Ui.grass)) {
    const frame = Ui.grassFrame(g);
    if (g.split && Ui.grassAnimCmd(g) === 0) {
      G.draw(sheet.image, grass_half_quad(sheet, frame, !behindHost),
        g.x - 8, g.y - 8 + (behindHost ? 0 : 8));
    } else if (!behindHost) {
      G.draw(sheet.image, sheet.quads[frame + 1], g.x - 8, g.y - 8);
    }
  }
}

// Lua: teachy_tv.lua:1182
// pokefirered/src/menu_indicators.c:289 gSineTable[tSinePos] * multiplier / 256
function arrow_bob(freq: number): number {
  const v = Trig.sin(mod((Ui._arrowK ?? 0) * freq, 256)) * 2 / 256;
  return v < 0 ? Math.ceil(v) : Math.floor(v);
}

// Lua: teachy_tv.lua:1189
// pokefirered/src/teachy_tv.c:568 TeachyTvSetupScrollIndicatorArrowPair
function draw_scroll_arrows(total: number, shown: number): void {
  if (!TTV.hasTmCase(Ui._session, Ui._bag) || total <= shown) return;
  if (Ui.scroll > 0) {
    BagChrome.drawArrow("up", ARROW_X - 8, ARROW_UP_Y - 8 + arrow_bob(8));
  }
  if (Ui.scroll < total - shown) {
    BagChrome.drawArrow("down", ARROW_X - 8, ARROW_DOWN_Y - 8 + arrow_bob(-8));
  }
}

export const Ui = {
  open: false as boolean,
  state: "list" as string,
  cursor: 1,
  scroll: 0,
  page: 1,
  phase: "intro" as string,
  step: 1,
  frames: 0,
  suspended: false as boolean,
  // pokefirered/src/teachy_tv.c:519 ChangeBgX(3, 0x1000, 2)
  bg3X: -16,
  bg3Y: 40,
  // pokefirered/src/teachy_tv.c:521 grassAnimCounterLo / grassAnimCounterHi
  grassLo: 0,
  grassHi: 3,
  grass: seq<any>() as LuaTable,
  grassDx: 0,
  grassDy: 0,
  static: undefined as LuaTable | undefined,

  // screen state (Brian's Ui.* / Ui._* fields)
  closing: false as boolean,
  title: false as boolean,
  endCard: false as boolean,
  aborted: false as boolean,
  hostVisible: false as boolean,
  hostX: undefined as number | undefined,
  hostY: undefined as number | undefined,
  hostFacing: undefined as string | undefined,
  hostWalk: false as boolean,
  hostStep: false as boolean,
  _session: undefined as any,
  _bag: undefined as any,
  _onClose: undefined as (() => void) | undefined,
  _bagUnder: false as boolean,
  _rows: undefined as LuaTable | undefined,
  _pages: undefined as LuaTable | undefined,
  _acc: 0,
  _arrowK: 0,
  _bagPos: undefined as any,
  _images: {} as Record<string, any>,
  _chromeCutOut: false as boolean,
  _grassSheet: undefined as any,
  _staticQuads: undefined as any,

  bagDemo: BagDemo,
  tmDemo: TmDemo,

  // (Brian's window templates)
  LIST_WIN,
  BODY_WIN,

  // Lua: teachy_tv.lua:162
  artPath(name: string): string {
    return cache_root() + "/" + CACHE_SUB + "/" + name + ".rgba";
  },

  // Lua: teachy_tv.lua:199
  reloadAssets(): void {
    Ui._images = {};
    Ui._grassSheet = undefined;
    Ui._staticQuads = undefined;
  },

  // Lua: teachy_tv.lua:205
  isOpen(): boolean {
    return Ui.open;
  },

  // Lua: teachy_tv.lua:209
  rows(): LuaTable {
    return Ui._rows ?? seq();
  },

  // Lua: teachy_tv.lua:213
  pages(): LuaTable {
    return Ui._pages ?? seq();
  },

  // Lua: teachy_tv.lua:241
  stepName(): string | undefined {
    const cluster = TTV.STEPS[TTV.whichScript(Ui._session)];
    return cluster ? (cluster[Ui.step] ?? undefined) : undefined;
  },

  // Lua: teachy_tv.lua:247
  // pokefirered/src/teachy_tv.c:1163 TeachyTvGrassAnimationCheckIfNeedsToGenerateGrassObj
  grassAt(x: number, y: number): boolean {
    if (x < 0 || y < 0) return false;
    const high = (Math.floor(y / 16) + Ui.grassHi) * 16;
    const low = Math.floor(x / 16) + Ui.grassLo;
    return GRASS_MAP[high + low + 1] === 1;
  },

  // Lua: teachy_tv.lua:269
  grassAnimCmd(g: any): number {
    let cmd = Math.floor((g.frames ?? 0) / GRASS_FRAME_TICKS);
    if (cmd >= GRASS_FRAMES) cmd = GRASS_FRAMES - 1;
    return cmd;
  },

  // Lua: teachy_tv.lua:275
  grassFrame(g: any): number {
    return GRASS_ANIM[Ui.grassAnimCmd(g) + 1];
  },

  // Lua: teachy_tv.lua:339
  show(session?: any, bag?: any, optsIn?: any): void {
    const opts = optsIn ?? {};
    Ui.open = true;
    Ui._session = session ?? opts.session;
    Ui._bag = bag ?? opts.bag ?? (session ? session.bag : undefined);
    Ui._onClose = opts.onClose;
    Ui._bagUnder = Stack.has("bag");
    Ui._rows = TTV.menuItems(Ui._session, Ui._bag);
    const res = TTV.resources(Ui._session);
    Ui.scroll = res ? res.scrollOffset : 0;
    Ui.cursor = (res ? (res.scrollOffset + res.selectedRow) : 0) + 1;
    to_list();
    Ui.closing = false;
    Stack.push("teachy_tv", Ui as any, { hideBelow: true, fullscreen: true });
    // pokefirered/src/teachy_tv.c:490 PlayNewMapMusic
    song(Song.MUS_TEACHY_TV_MENU);
    // pokefirered/src/teachy_tv.c:499 BeginNormalPaletteFade(PALETTES_ALL, 0, 0x10, 0, 0)
    const F = fade();
    F.begin(F.MODE.FROM_BLACK, 1);
  },

  // Lua: teachy_tv.lua:361
  // pokefirered/src/teachy_tv.c:695 TeachyTvQuitFadeControlAndTaskDel
  finishClose(): void {
    if (!Ui.open) return;
    Ui.open = false;
    Ui.closing = false;
    Ui.state = "list";
    Ui._pages = undefined;
    Ui.suspended = false;
    Ui.hostVisible = false;
    Ui.static = undefined;
    Stack.pop("teachy_tv");
    // pokefirered/src/teachy_tv.c:705 Overworld_PlaySpecialMapMusic
    Audio.restoreMapSong();
    const F = fade();
    F.begin(F.MODE.FROM_BLACK, 1);
    const cb = Ui._onClose;
    Ui._onClose = undefined;
    if (cb) cb();
  },

  // Lua: teachy_tv.lua:381
  // pokefirered/src/teachy_tv.c:689 TeachyTvQuitBeginFade
  close(): void {
    if (!Ui.open || Ui.closing) return;
    Ui.closing = true;
    const F = fade();
    F.begin(F.MODE.TO_BLACK, 1, () => {
      if (Ui.closing) Ui.finishClose();
    });
  },

  // Lua: teachy_tv.lua:397
  // pokefirered/src/teachy_tv.c:804 RunTextPrinters_CheckActive
  printerActive(): boolean {
    const pages = Ui._pages;
    return pages != null && Ui.page < len(pages);
  },

  // Lua: teachy_tv.lua:614
  tick(): void {
    if (!Ui.open || Ui.suspended || Ui.closing) return;
    if (Ui.state !== "lesson") {
      // pokefirered/src/teachy_tv.c:718 TeachyTvBg2AnimController
      bg2_anim();
      Ui._arrowK = mod((Ui._arrowK ?? 0) + 1, 256);
      return;
    }
    const name = Ui.stepName();
    if (!name) {
      to_list();
      return;
    }
    Ui.frames = Ui.frames + 1;
    const fn = STEP[name];
    if (fn) fn();
    grass_step();
  },

  // Lua: teachy_tv.lua:633
  update(dt?: any): void {
    if (!Ui.open) return;
    if (Ui.closing) {
      // pokefirered/src/teachy_tv.c:697 !gPaletteFade.active
      if (!fade().isActive()) Ui.finishClose();
      return;
    }
    Ui._acc = (Ui._acc ?? 0) + (tonumber(dt) ?? 0);
    let n = 0;
    while (Ui._acc >= FRAME && n < 8) {
      Ui._acc = Ui._acc - FRAME;
      n = n + 1;
      Ui.tick();
    }
    if (Ui._acc > FRAME) Ui._acc = 0;
  },

  // Lua: teachy_tv.lua:651
  // pokefirered/src/teachy_tv.c:1208 TeachyTvRestorePlayerPartyCallback
  resumeFromDemonstration(outcome: any): void {
    const session = Ui._session;
    const script = TTV.whichScript(session);
    const mode = TTV.modeAfterBattle(outcome);
    if (mode === TTV.MODE.RESUME_LIST) {
      TTV.setModeToResume(session);
    }
    TTV.returnToTv(session);
    Ui.suspended = false;
    Ui.closing = false;
    Ui.open = true;
    Ui.static = undefined;
    if (!Stack.has("teachy_tv")) {
      Stack.push("teachy_tv", Ui as any, { hideBelow: true, fullscreen: true });
    }
    // pokefirered/src/teachy_tv.c:499 BeginNormalPaletteFade(PALETTES_ALL, 0, 0x10, 0, 0)
    const F = fade();
    F.begin(F.MODE.FROM_BLACK, 1);
    if (mode === TTV.MODE.RESUME_LIST) {
      // pokefirered/src/teachy_tv.c:490 PlayNewMapMusic
      song(Song.MUS_TEACHY_TV_MENU);
      to_list();
      return;
    }
    // pokefirered/src/teachy_tv.c:1214 PlayNewMapMusic(MUS_FOLLOW_ME)
    song(Song.MUS_FOLLOW_ME);
    Ui.state = "lesson";
    Ui._pages = undefined;
    Ui.step = (TTV.RESUME_STEP[script] ?? 0) + 1;
    Ui.frames = 0;
    // pokefirered/src/teachy_tv.c:505 TeachyTvSetupBg
    reset_bg3();
    // pokefirered/src/teachy_tv.c:646 TeachyTvSetupPostBattleWindowAndObj
    host(T.DUDE_X_END, T.DUDE_Y, "down", false);
    if (TTV.endsInBattle(script)) {
      // pokefirered/src/teachy_tv.c:660 ChangeBgX(3, 0x3000, 1), ChangeBgY(3, 0x3000, 2)
      Ui.bg3X = Ui.bg3X + 48;
      Ui.bg3Y = Ui.bg3Y - 48;
      Ui.grassLo = Ui.grassLo + 3;
      Ui.grassHi = Ui.grassHi - 3;
    }
    Ui.grassDx = 0;
    Ui.grassDy = 0;
    grass_spawn(T.DUDE_X_END, T.DUDE_Y, true);
  },

  // Lua: teachy_tv.lua:887
  // pokefirered/src/tm_case.c:1322 Pokedude_InitTMCase
  openPokedudeTmCase(): void {
    const session = Ui._session;
    TmDemo.plan = TTV.TM_CASE_DEMO;
    TmDemo.pages = undefined;
    TmDemo.page = 1;
    TmDemo._acc = 0;
    TmDemo.interrupted = false;
    TmDemo.finished = false;
    TTV.initPokedudeTmCase(session);
    Ui.suspended = true;
    // pokefirered/src/tm_case.c:1338 InitTMCase(TMCASE_POKEDUDE, CB2_ReturnToTeachyTV, 0)
    TmCase.show(session, session ? session.bag : undefined, {
      cursor: 1,
      scroll: 0,
      onClose: () => { Ui.finishPokedudeTmCase(); },
    });
    Stack.push("teachy_pokedude_tm_case", TmDemo, { drawUnder: true, hideBelow: false });
    tm_enter(1);
  },

  // Lua: teachy_tv.lua:909
  // pokefirered/src/tm_case.c:1446 tPokedudeState 21 restores the player's bag
  finishPokedudeTmCase(): void {
    const session = Ui._session;
    Stack.pop("teachy_pokedude_tm_case");
    TTV.restorePokedudeTmCase(session);
    if (TmDemo.interrupted) {
      TTV.setModeToResume(session);
    }
    Ui.returnFromDemo();
  },

  // Lua: teachy_tv.lua:920
  // pokefirered/src/teachy_tv.c:1087 TeachyTvSetupBagItemsByOptionChosen
  openPokedudeBag(scriptId: any): void {
    const session = Ui._session;
    const bag = session ? session.bag : undefined;
    Ui._bagPos = snapshot_bag_positions(session, bag);
    BagDemo.script = scriptId;
    BagDemo.location = TTV.initPokedudeBag(session, scriptId);
    BagDemo.plan = TTV.bagDemoPlan(scriptId);
    BagDemo.frames = 0;
    BagDemo.index = 1;
    BagDemo._acc = 0;
    BagDemo.interrupted = false;
    BagDemo.finished = false;
    BagDemo.toTmCase = false;
    Ui.suspended = true;
    // pokefirered/src/item_menu.c:2079 ResetBagCursorPositions
    apply_bag_positions(session, bag, undefined);
    // pokefirered/src/item_menu.c:2189 GoToBagMenu
    BagMenu.show(bag, {
      session,
      pocket: "ITEMS",
      onClose: () => { Ui.finishPokedudeBag(); },
    });
    Stack.push("teachy_pokedude_bag", BagDemo, { drawUnder: true, hideBelow: false });
  },

  // Lua: teachy_tv.lua:947
  // pokefirered/src/teachy_tv.c:437 CB2_ReturnToTeachyTV
  finishPokedudeBag(): void {
    const session = Ui._session;
    Stack.pop("teachy_pokedude_bag");
    TTV.restorePlayerBag(session);
    apply_bag_positions(session, session ? session.bag : undefined, Ui._bagPos);
    Ui._bagPos = undefined;
    // pokefirered/src/item_menu.c:2385 exitCB = Pokedude_InitTMCase
    if (BagDemo.toTmCase && !BagDemo.interrupted) {
      BagDemo.toTmCase = false;
      Ui.openPokedudeTmCase();
      return;
    }
    if (BagDemo.interrupted) {
      TTV.setModeToResume(session);
    }
    Ui.returnFromDemo();
  },

  // Lua: teachy_tv.lua:966
  // pokefirered/src/teachy_tv.c:437 CB2_ReturnToTeachyTV
  returnFromDemo(): void {
    const session = Ui._session;
    const res = TTV.returnToTv(session);
    const script = TTV.whichScript(session);
    if (Ui._bagUnder) {
      BagMenu.show(session ? session.bag : undefined, { session });
    }
    Stack.push("teachy_tv", Ui as any, { hideBelow: true, fullscreen: true });
    Ui.open = true;
    Ui.suspended = false;
    if (res && res.mode === TTV.MODE.RESUME_SCRIPT) {
      Ui.state = "lesson";
      Ui._pages = undefined;
      Ui.step = (TTV.RESUME_STEP[script] ?? 0) + 1;
      Ui.frames = 0;
      song(Song.MUS_FOLLOW_ME);
      // pokefirered/src/teachy_tv.c:646 TeachyTvSetupPostBattleWindowAndObj
      host(T.DUDE_X_END, T.DUDE_Y, "down", false);
      return;
    }
    // pokefirered/src/teachy_tv.c:490 PlayNewMapMusic
    song(Song.MUS_TEACHY_TV_MENU);
    to_list();
  },

  // Lua: teachy_tv.lua:992
  handleInput(input: any): void {
    if (!Ui.open || Ui.suspended || Ui.closing) return;

    // pokefirered/src/teachy_tv.c:808 TeachyTvRenderMsgAndSwitchClusterFuncs
    if (Ui.state === "lesson") {
      if (input.wasPressed("b")) {
        se(SeIds.SE_SELECT);
        abort_to_end();
      } else if (input.wasPressed("a")) {
        if (Ui.printerActive()) {
          se(SeIds.SE_SELECT);
          Ui.page = Ui.page + 1;
        } else if (Ui.stepName() === "erase_text_window_if_key_pressed") {
          se(SeIds.SE_SELECT);
          Ui._pages = undefined;
          step_advance();
        }
      }
      return;
    }

    // pokefirered/src/teachy_tv.c:719 !gPaletteFade.active
    if (fade().isActive()) return;
    const rows = Ui.rows();
    if (input.wasPressed("up")) {
      if (Ui.cursor > 1) {
        Ui.cursor = Ui.cursor - 1;
        clamp_cursor();
        sync_resources();
        se(SeIds.SE_SELECT);
      }
    } else if (input.wasPressed("down")) {
      if (Ui.cursor < len(rows)) {
        Ui.cursor = Ui.cursor + 1;
        clamp_cursor();
        sync_resources();
        se(SeIds.SE_SELECT);
      }
    } else if (input.wasPressed("a")) {
      se(SeIds.SE_SELECT);
      const row = rows[Ui.cursor];
      if (!row || row.index === TTV.CANCEL) {
        Ui.close();
      } else {
        begin_lesson(row.index);
      }
    } else if (input.wasPressed("b")) {
      // pokefirered/include/list_menu.h:8 LIST_CANCEL
      se(SeIds.SE_SELECT);
      Ui.close();
    } else if (input.wasPressed("select") && !Ui._bagUnder) {
      // pokefirered/src/teachy_tv.c:723 sStaticResources.callback != CB2_BagMenuFromStartMenu
      se(SeIds.SE_SELECT);
      Ui.close();
    }
  },

  // Lua: teachy_tv.lua:1050
  // pokefirered/src/teachy_tv.c:526 TeachyTvLoadGraphic
  chrome(): any {
    return art("screen");
  },

  // Lua: teachy_tv.lua:1055
  // pokefirered/src/teachy_tv.c:118 sBgTemplates[1] priority 0
  chromeCutOut(): boolean {
    Ui.chrome();
    return Ui._chromeCutOut ? true : false;
  },

  // Lua: teachy_tv.lua:1061
  // pokefirered/src/teachy_tv.c:761 CopyToBgTilemapBufferRect_ChangePalette
  titleArt(): any {
    return art("title");
  },

  // Lua: teachy_tv.lua:1066
  // pokefirered/src/teachy_tv.c:869 sBg1EndGraphic
  endArt(): any {
    return art("end");
  },

  // Lua: teachy_tv.lua:1071
  // pokefirered/src/teachy_tv.c:1218 TeachyTvLoadBg3Map
  bg3Art(): any {
    return art("bg3", BG3_W, BG3_H);
  },

  // Lua: teachy_tv.lua:1076
  // pokefirered/src/teachy_tv.c:637 tilemapBuffer[32 * i + j] = ((Random() & 3) << 10) + 0x301F
  staticArt(): any {
    return art("static", 32, 8);
  },

  // Lua: teachy_tv.lua:1201
  // pokefirered/src/teachy_tv.c:936 TTVcmd_EraseTextWindowIfKeyPressed
  waitingForKey(): boolean {
    if (Ui.state !== "lesson") return false;
    if (Ui.printerActive()) return true;
    return Ui.stepName() === "erase_text_window_if_key_pressed";
  },

  // Lua: teachy_tv.lua:1207
  draw(): void {
    if (!Ui.open) return;
    // `love and love.graphics`: always present here

    G.setColor(0.13, 0.16, 0.28, 1);
    G.rectangle("fill", 0, 0, SCREEN_W, SCREEN_H);
    G.setColor(1, 1, 1, 1);
    draw_bg3();
    draw_static();

    const cutOut = Ui.chromeCutOut();
    if (!cutOut) draw_chrome();

    if (Ui.state === "list") {
      // pokefirered/src/teachy_tv.c:600 SetGpuReg(REG_OFFSET_BLDCNT, 0xCC)
      G.setColor(0, 0, 0, LIST_DARKEN);
      G.rectangle("fill", WIN0_X0, WIN0_Y0, WIN0_X1 - WIN0_X0, WIN0_Y1 - WIN0_Y0);
      G.setColor(1, 1, 1, 1);
      if (cutOut) draw_chrome();
      const rows = Ui.rows();
      const shown = maxShowed();
      // pokefirered/src/teachy_tv.c:559 upText_Y
      const baseY = LIST_TPL.top * 8 + (TTV.hasTmCase(Ui._session, Ui._bag) ? 6 : 14);
      for (let i = 1; i <= shown; i++) {
        const idx = Ui.scroll + i;
        const row = rows[idx];
        if (!row) break;
        const y = baseY + (i - 1) * ROW_PITCH;
        if (idx === Ui.cursor) {
          // pokefirered/src/teachy_tv.c:235 cursor_X
          Window.cursorPx(LIST_TPL.left * 8, y, LIST_CURSOR_OPTS);
        }
        // pokefirered/src/teachy_tv.c:234 item_X
        FrlgFont.draw(tostring(row.label), LIST_TPL.left * 8 + 8, y, LIST_TEXT_OPTS);
      }
      draw_scroll_arrows(len(rows), shown);
      return;
    }

    if (Ui.title) {
      const title = Ui.titleArt();
      if (title) {
        G.setColor(1, 1, 1, 1);
        G.draw(title, 0, 0);
      }
    }

    draw_grass(true);
    draw_host();
    draw_grass(false);
    if (cutOut) draw_chrome();

    if (Ui.endCard) {
      const card = Ui.endArt();
      if (card) {
        G.setColor(1, 1, 1, 1);
        G.draw(card, 0, 0);
      }
    }

    const page = Ui.pages()[Ui.page];
    if (!page) return;
    // pokefirered/src/teachy_tv.c:676 TeachyTvInitTextPrinter
    const [, endX, endY] = FrlgFont.draw(page, BODY_TPL.left * 8, BODY_TPL.top * 8 + 1, BODY_TEXT_OPTS);
    if (Ui.waitingForKey()) {
      // pokefirered/src/text.c:471 TextPrinterDrawDownArrow
      const t = Timer.getTime() ?? 0;
      const frame = PROMPT_BOUNCE[1 + mod(Math.floor(t * 8), len(PROMPT_BOUNCE))] ?? 0;
      let ax = (endX ?? (BODY_TPL.left * 8 + 16)) + 2;
      const ay = endY ?? (BODY_TPL.top * 8 + 1);
      const limit = BODY_TPL.left * 8 + BODY_TPL.width * 8 - 10;
      if (ax > limit) ax = limit;
      Chrome.promptArrow(ax, ay, frame);
    }
  },
};

export default Ui;

G3Lazy["src.ui.game3.teachy_tv"] = Ui;
