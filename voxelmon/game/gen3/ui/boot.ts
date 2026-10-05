// Port of gen1recomp src/ui/game3/boot.lua (GPLv3 + additional terms; see LICENSE.md).
// Fire Red boot UI: copyright → title → main menu → Oak speech → field.
// Oak onboarding lives in oak_speech.lua (pret oak_speech.c task chain).
//
// The `love and love.filesystem` / `love.graphics` guards always hold under
// LÖVE, so only that branch is ported (platform Fs / G).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Display } from "../core/display.ts";
import { Window } from "./window.ts";
import { Audio } from "../core/audio.ts";
import { SE } from "../core/se_ids.ts";
import { Scene as NewGameScene } from "./new_game_scene.ts";
import { NamingChrome } from "./naming_chrome.ts";
import { Pal } from "../core/pal_fade.ts";
import { IntroMovie } from "./intro_movie.ts";
import { Title as TitleScreen } from "./title_screen.ts";
import { FrlgFont, type Col } from "./frlg_font.ts";
import { Chrome } from "./chrome.ts";
import { RomText } from "../core/rom_text.ts";
import { MysteryGift } from "../core/mystery_gift.ts";
import { Ui as MysteryGiftUi } from "./mystery_gift.ts";
import { ListMenu } from "./list_menu.ts";
import { BootModules } from "./boot_modules.ts";
// Brian's lazy requires (src.core.game3.profile, .scripting.flags, .dex, .options, src.core.SaveData)
import { Profile } from "../core/profile.ts";
import { Flags } from "../core/scripting/flags.ts";
import { Dex } from "../core/dex.ts";
import { Options } from "../core/options.ts";
import { SaveData } from "../shared/core/SaveData.ts";
import { NotPortedError } from "../notported.ts";
import { Fs } from "../platform/fs.ts";
import { G } from "../platform/graphics.ts";
import type { Image, Quad } from "../platform/image.ts";
import { gmatch } from "../platform/lpattern.ts";
import { len, seq } from "../platform/lt.ts";
import { format, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";

/** pcall(f, ...): [true, result] or [false, err]. A not-ported stub is not an error to swallow. */
function pcall<A extends unknown[], R>(f: (...a: A) => R, ...a: A): [true, R] | [false, unknown] {
  try {
    return [true, f(...a)];
  } catch (e) {
    if (e instanceof NotPortedError) throw e;
    return [false, e];
  }
}

/** Lua `a or b`. */
function lor<T, U>(a: T, b: U): T | U {
  return truthy(a) ? a : b;
}

const PHASE = {
  INTRO: "intro",
  COPYRIGHT: "copyright",
  TITLE: "title",
  TITLE_RESTART: "title_restart",
  TITLE_CRY: "title_cry",
  MENU: "menu",
  MYSTERY_GIFT: "mystery_gift",
  CONTROLS: "controls",
  PIKACHU: "pikachu",
  OAK: "oak",
};

const INTRO_FALLBACK = "data/generated/gba/intro";

// Lua: boot.lua:38
function loadIntroIndex(): any {
  const [ok, chunk] = pcall(() => Fs.load("data/generated/intro.lua")[0]);
  if (!ok || typeof chunk !== "function") return null;
  const [ok2, t] = pcall(chunk);
  if (ok2 && typeof t === "object" && t !== null && !truthy((t as any).stub)) return t;
  return null;
}

// Lua: boot.lua:47
function loadImage(rel: string | null | undefined): Image | null {
  if (!rel || !Fs.getInfo(rel)) {
    return null;
  }
  const [ok, img] = pcall(G.newImage, rel);
  if (ok) {
    img.setFilter("nearest", "nearest"); // `if img.setFilter`: the platform Image has it
    return img;
  }
  return null;
}

// Lua: boot.lua:59
function newBoot(game?: any): any {
  const mods = BootModules.resolve(Profile.active());
  if (mods.custom) return BootModules.newState(Boot, mods, game);
  const index = loadIntroIndex();
  const base = INTRO_FALLBACK;
  const path = (key: string, file: string): string => {
    if (index && truthy(index[key])) return index[key];
    return base + "/" + file;
  };

  const platform = loadImage(path("platform", "platform.png"));
  let platformQuad: Quad | null = null;
  if (platform) {
    const [pw, ph] = platform.getDimensions();
    if (pw >= 32 && ph >= 32) {
      platformQuad = G.newQuad(0, 0, 32, 32, pw, ph);
    }
  }

  const titleFlamesImg = loadImage(path("titleFlames", "title_flames.png"));

  const assets = {
    oakSprite: loadImage(path("oakPic", "oak.png")),
    boySprite: loadImage(path("playerPic", "boy.png")),
    girlSprite: loadImage(path("playerPicFemale", "girl.png")),
    rivalSprite: loadImage(path("rivalPic", "rival.png")),
    platform,
    platformQuad,
    oakSpeechBg: loadImage(path("oakSpeechBg", "oak_speech_bg.png")),
    controlsPage1: loadImage(path("controlsPage1", "controls_page1.png")),
    controlsPage2: loadImage(path("controlsPage2", "controls_page2.png")),
    controlsPage3: loadImage(path("controlsPage3", "controls_page3.png")),
    pikachuBg: loadImage(path("pikachuIntroBg", "pikachu_intro_bg.png")),
    pikachuBody: loadImage(path("pikachuBody", "pikachu_body.png")),
    pikachuEars: loadImage(path("pikachuEars", "pikachu_ears.png")),
    pikachuEyes: loadImage(path("pikachuEyes", "pikachu_eyes.png")),
    nidoranFront: loadImage(path("nidoranFront", "nidoran_f.png")),
    ballPoke: loadImage(path("ballPoke", "ball_poke.png")),
    // Intro Movie Assets
    introCopyright: loadImage(path("introCopyright", "intro_copyright.png")),
    introGfBg: loadImage(path("introGfBg", "intro_gf_bg.png")),
    introGfText: loadImage(path("introGfText", "intro_gf_text.png")),
    introGfLogo: loadImage(path("introGfLogo", "intro_gf_logo.png")),
    introStar: loadImage(path("introStar", "intro_star.png")),
    introSparklesSmall: loadImage(path("introSparklesSmall", "intro_sparkles_small.png")),
    introSparklesBig: loadImage(path("introSparklesBig", "intro_sparkles_big.png")),
    introPresents: loadImage(path("introPresents", "intro_presents.png")),
    introScene1Grass: loadImage(path("introScene1Grass", "intro_scene1_grass.png")),
    introScene1Bg: loadImage(path("introScene1Bg", "intro_scene1_bg.png")),
    introScene2Bg: loadImage(path("introScene2Bg", "intro_scene2_bg.png")),
    introScene2Plants: loadImage(path("introScene2Plants", "intro_scene2_plants.png")),
    introScene2GengarClose: loadImage(path("introScene2GengarClose", "intro_scene2_gengar_close.png")),
    introScene2NidorinoClose: loadImage(path("introScene2NidorinoClose", "intro_scene2_nidorino_close.png")),
    introScene2Gengar: loadImage(path("introScene2Gengar", "intro_scene2_gengar.png")),
    introScene2Nidorino: loadImage(path("introScene2Nidorino", "intro_scene2_nidorino.png")),
    introScene3Bg: loadImage(path("introScene3Bg", "intro_scene3_bg.png")),
    introScene3GengarAnim: loadImage(path("introScene3GengarAnim", "intro_scene3_gengar_anim.png")),
    introScene3Grass: loadImage(path("introScene3Grass", "intro_scene3_grass.png")),
    introScene3GengarStatic: loadImage(path("introScene3GengarStatic", "intro_scene3_gengar_static.png")),
    introScene3Nidorino: loadImage(path("introScene3Nidorino", "intro_scene3_nidorino.png")),
    introScene3Swipe: loadImage(path("introScene3Swipe", "intro_scene3_swipe.png")),
    introScene3RecoilDust: loadImage(path("introScene3RecoilDust", "intro_scene3_recoil_dust.png")),
    titleFlames: titleFlamesImg,
    titleStreak: loadImage(path("titleStreak", "title_streak.png")),
    titleSlash: loadImage(path("titleSlash", "title_slash.png")),
    titleBorder: loadImage(path("titleBorder", "title_border_bg.png")),
  };

  const state = {
    phase: Boot.PHASE.INTRO,
    timer: 0,
    blink: 0,
    menuIndex: 1,
    hasContinue: false,
    introIndex: index,
    assets,
    introMovie: null,
    oak: null,
    titleScreen: loadImage(path("titleScreen", "title_screen.png")),
    titleLogo: loadImage(path("titleLogo", "title_logo.png")),
    titleMon: loadImage(path("boxArtMon", "box_art_mon.png")),
    titleBorder: assets.titleBorder,
    pressStart: loadImage(path("pressStart", "press_start.png")),
    copyrightLayer: loadImage(path("copyrightPressStart", "copyright_press_start.png")),
  };
  return state;
}

// Lua: boot.lua:147
function setHasContinue(state: any, yes: unknown): void {
  state.hasContinue = truthy(yes);
  state.menuIndex = 1;
}

// Lua: boot.lua:152
function setContinueInfo(state: any, info: any): void {
  state.continueInfo = info;
}

// Lua: boot.lua:156
function setSaveStatus(state: any, status: any): void {
  state.saveStatus = status;
}

const isTable = (v: unknown): boolean => typeof v === "object" && v !== null;

// Lua: boot.lua:160
function continueInfoFromSave(save: any): any {
  if (!isTable(save)) return null;
  const store = { flags: isTable(save.flags) ? save.flags : {} };
  const pt = isTable(save.playTime) ? save.playTime
    : isTable(save.playtime) ? save.playtime : {};
  const n = Dex.summaryCount(save);
  const name = tostring(lor(lor(save.name, save.playerName), ""));
  const forVersion = typeof save.version === "string" ? Flags.forVersion(save.version) : null;
  // forVersion is a table (truthy) or null, so `??` is Lua's `or` here.
  const ids = (forVersion ?? Flags).IDS;
  return {
    name: FrlgFont.truncate(name, 7),
    gender: tonumber(save.gender) ?? 0,
    hours: tonumber(pt.hours) ?? 0,
    minutes: tonumber(pt.minutes) ?? 0,
    hasDex: Flags.getFlag(store, null, ids.SYS_POKEDEX_GET) === true,
    // pokefirered/src/main_menu.c:236 IsMysteryGiftEnabled
    mysteryGift: Flags.getFlag(store, null,
      lor(lor(ids.SYS_MYSTERY_GIFT_ENABLED, ids.FLAG_SYS_MYSTERY_GIFT_ENABLE), 0x839)) === true,
    dexCount: n,
    badges: Flags.countBadges(store),
    frameType: tonumber(isTable(save.options)
      ? Options.block(save.options).frameType : null) ?? 0,
  };
}

// pokefirered/src/main_menu.c:370 MAIN_MENU_MYSTERYGIFT
// Lua: boot.lua:186
function hasMysteryGift(state: any): boolean {
  return state.hasContinue === true;
}

const MENU_SCROLL_TILES = 4;

// Lua: boot.lua:194
function menuItems(state: any): (string | null)[] {
  if (state.hasContinue) {
    if (hasMysteryGift(state)) {
      return seq("CONTINUE", "NEW GAME", "MYSTERY GIFT", "EXIT");
    }
    return seq("CONTINUE", "NEW GAME", "EXIT");
  }
  return seq("NEW GAME", "EXIT");
}

// Lua: boot.lua:206
function beginNewGame(state: any): null {
  NamingChrome.install();
  state.phase = Boot.PHASE.CONTROLS;
  state.newGame = NewGameScene.new(state.assets, { textSpeed: state.textSpeed });
  state.timer = 0;
  return null;
}

// Lua: boot.lua:214
function setTextSpeed(state: any, speed: unknown): void {
  state.textSpeed = tonumber(speed);
}

// Lua: boot.lua:218
function beginMenuFade(state: any, color: string, from: number, to: number, after: string | null): void {
  state.fadeColor = color;
  state.fadeTarget = to;
  state.fadeThen = after;
  state.menuFade = Pal.new();
  state.menuFade.beginFade(Pal.ALL, 0, from, to, color === "white" ? Pal.WHITE : Pal.BLACK); // pokefirered/src/main_menu.c:574
  state.fadeT = state.menuFade.slots[0].y;
}

// pokefirered/src/mystery_gift_menu.c:1095 CreateMysteryGiftTask
// Lua: boot.lua:228
function openMysteryGift(state: any): void {
  let okLoad = false, raw: any = null;
  if (SaveData.load) [okLoad, raw] = pcall(SaveData.load);
  const loaded = okLoad && isTable(raw);
  const save = loaded ? raw : {};
  state.giftSave = save;
  state.gift = MysteryGiftUi.new({
    session: MysteryGift.sessionFromSave(save),
    onSave: (sess: any): boolean => {
      if (!loaded) return false;
      MysteryGift.applyToSave(sess, save);
      if (!SaveData.save) return false;
      const [okSave, written] = pcall(SaveData.save, save);
      return okSave && written !== false;
    },
  });
  state.phase = Boot.PHASE.MYSTERY_GIFT;
  state.timer = 0;
}

// pokefirered/src/mystery_gift_menu.c:455 MainCB_FreeAllBuffersAndReturnToInitTitleScreen
// Lua: boot.lua:252
function closeMysteryGift(state: any): void {
  if (state.giftSave) {
    Boot.setContinueInfo(state, Boot.continueInfoFromSave(state.giftSave));
  }
  if (state.gift) MysteryGiftUi.close(state.gift);
  state.gift = null;
  state.giftSave = null;
  state.phase = Boot.PHASE.MENU;
  state.menuIndex = 1;
  beginMenuFade(state, "white", 16, 0, null); // pokefirered/src/main_menu.c:398
}

// Lua: boot.lua:264
function enterTitleLocal(state: any): void {
  TitleScreen.enter(state);
}

// Lua: boot.lua:268
function enterTitle(state: any): void {
  if (state.custom) return BootModules.enterTitle(Boot, state);
  enterTitleLocal(state);
}

// Lua: boot.lua:273
function leaveTitle(state: any): void {
  if (state._titleActive) {
    TitleScreen.leave(state);
  }
}

// Lua: boot.lua:279
function saveErrorPages(status: any): (string | null)[] {
  // pokefirered/src/main_menu.c:249
  const key = status === "invalid" ? "gText_SaveFileHasBeenDeleted" : "gText_SaveFileCorrupted";
  const pages = seq<string>();
  for (const [page] of gmatch(RomText.ascii(key) + "\\p", "(.-)\\p")) {
    if (page !== "") pages[len(pages) + 1] = page as string;
  }
  return pages;
}

const ARROW_FRAMES = seq(0, 1, 2, 1); // pokefirered/src/text.c:35

// Lua: boot.lua:291
function beginSaveError(state: any): void {
  const pages = saveErrorPages(state.saveStatus);
  state.saveError = {
    pages, page: 1, revealed: 0, delay: 0,
    total: FrlgFont.countChars(pages[1]) + 1,
    arrowIdx: 0, arrowDelay: 0,
  };
  state.menuIndex = 1;
  beginMenuFade(state, "white", 16, 0, null); // pokefirered/src/main_menu.c:283
}

// Lua: boot.lua:302
function tickSaveError(state: any, pressed: (k: string) => any): null {
  const e = state.saveError;
  if (e.waiting === "prompt") {
    if (e.arrowDelay !== 0) { // pokefirered/src/text.c:478
      e.arrowDelay = e.arrowDelay - 1;
    } else {
      e.arrowFrame = ARROW_FRAMES[e.arrowIdx + 1];
      e.arrowIdx = (e.arrowIdx + 1) % 4;
      e.arrowDelay = 8; // pokefirered/src/text.c:516
    }
    if (pressed("a") || pressed("b")) { // pokefirered/src/text.c:560
      Audio.playSe(SE.SE_SELECT);
      e.page = e.page + 1;
      e.revealed = 0;
      e.total = FrlgFont.countChars(e.pages[e.page]) + 1;
      e.waiting = null; e.arrowFrame = null; e.arrowIdx = 0; e.arrowDelay = 0;
    }
    return null;
  } else if (e.waiting === "done") {
    if (pressed("a")) { // pokefirered/src/main_menu.c:293
      state.saveError = null;
      state.phase = Boot.PHASE.MENU;
      state.menuIndex = 1;
      beginMenuFade(state, "white", 16, 0, null); // pokefirered/src/main_menu.c:398
    }
    return null;
  }
  if (e.delay > 0) { // pokefirered/src/text.c:642
    e.delay = e.delay - 1;
    return null;
  }
  e.delay = 1; // pokefirered/src/text_printer.c:93
  e.revealed = e.revealed + 1;
  if (e.revealed >= e.total) {
    e.waiting = (e.page < len(e.pages)) ? "prompt" : "done";
  }
  return null;
}

// Lua: boot.lua:341
function update(state: any, input: any, dt?: number): any {
  if (state.custom) return BootModules.update(Boot, state, input, dt);
  dt = dt ?? (1 / 60);
  state.timer = (state.timer ?? 0) + dt;
  state.blink = (state.blink ?? 0) + dt;

  const a = (): any => {
    return input && input.wasPressed && (input.wasPressed("a") || input.wasPressed("start"));
  }; // (unused in Brian's too)
  const up = (): any => {
    return input && input.wasPressed && input.wasPressed("up");
  };
  const down = (): any => {
    return input && input.wasPressed && input.wasPressed("down");
  };

  if (state.phase === Boot.PHASE.INTRO) {
    if (!state.introMovie) {
      state.introMovie = IntroMovie.new(state.assets);
    }
    if (truthy(state.introMovie.update(input, dt))) {
      state.introMovie.destroy();
      state.introMovie = null;
      state.phase = Boot.PHASE.TITLE;
      state.timer = 0;
      enterTitleLocal(state);
    }
    return null;
  }

  if (state.phase === Boot.PHASE.COPYRIGHT) {
    state.phase = Boot.PHASE.INTRO;
    state.introMovie = IntroMovie.new(state.assets);
    state.timer = 0;
    return null;
  }

  if (state.phase === Boot.PHASE.TITLE || state.phase === Boot.PHASE.TITLE_CRY
      || state.phase === Boot.PHASE.TITLE_RESTART) {
    const result = TitleScreen.update(state, input, dt);
    const scene = TitleScreen.scene(state);
    if (scene === TitleScreen.SCENE.CRY) {
      state.phase = Boot.PHASE.TITLE_CRY;
    } else if (scene === TitleScreen.SCENE.RESTART) {
      state.phase = Boot.PHASE.TITLE_RESTART;
    } else {
      state.phase = Boot.PHASE.TITLE;
    }
    if (result === "restart") {
      leaveTitle(state);
      state.phase = Boot.PHASE.INTRO; // pokefirered/src/title_screen.c:703
      state.introMovie = IntroMovie.new(state.assets);
      state.timer = 0;
    } else if (result === "menu") {
      leaveTitle(state);
      state.timer = 0;
      if (state.saveStatus === "invalid" || state.saveStatus === "error") { // pokefirered/src/main_menu.c:246
        state.phase = Boot.PHASE.MENU;
        beginSaveError(state);
        return null;
      }
      state.phase = Boot.PHASE.MENU;
      state.menuIndex = 1;
      beginMenuFade(state, "white", 16, 0, null); // pokefirered/src/main_menu.c:398
    }
    return null;
  }

  if (state.phase === Boot.PHASE.MENU) {
    const mf = state.menuFade;
    if (mf && mf.fadeActive()) {
      mf.updateFade();
      state.fadeT = mf.slots[0].y;
      return null;
    }
    const pending = state.fadeThen;
    if (pending) {
      state.fadeThen = null;
      if (pending === "continue") {
        state.fadeT = 0; state.fadeTarget = 0;
        // NOT FAITHFUL: link deferred. Brian calls
        // require("src.core.game3.link.trade").resumePending() here with no
        // guard; link trades are deferred, so the offline path (no pending
        // trade to settle) is taken.
        return { action: "continue" };
      } else if (pending === "new_game") {
        state.fadeT = 0; state.fadeTarget = 0;
        return beginNewGame(state);
      } else if (pending === "exit") {
        state.fadeT = 0; state.fadeTarget = 0;
        return { action: "exit" };
      } else if (pending === "mystery_gift") {
        state.fadeT = 0; state.fadeTarget = 0;
        openMysteryGift(state);
      } else if (pending === "title") {
        state.fadeT = 0; state.fadeTarget = 0;
        state.phase = Boot.PHASE.TITLE;
        state.timer = 0;
        enterTitleLocal(state);
      }
      return null;
    }
    const items = menuItems(state);
    const pressed = (k: string): any => input && input.wasPressed && input.wasPressed(k);
    if (state.saveError) {
      return tickSaveError(state, pressed);
    }
    if (pressed("a")) { // pokefirered/src/main_menu.c:570
      Audio.playSe(SE.SE_SELECT);
      const choice = items[state.menuIndex];
      const fadeAction = (choice === "CONTINUE") ? "continue"
        : (choice === "NEW GAME") ? "new_game"
        // pokefirered/src/main_menu.c:483 MAIN_MENU_MYSTERYGIFT
        : (choice === "MYSTERY GIFT") ? "mystery_gift"
        : "exit";
      beginMenuFade(state, "black", 0, 16, fadeAction);
    } else if (pressed("b")) { // pokefirered/src/main_menu.c:577
      Audio.playSe(SE.SE_SELECT);
      beginMenuFade(state, "black", 0, 16, "title");
    } else if (up() && state.menuIndex > 1) {
      state.menuIndex = state.menuIndex - 1;
      if (state.menuIndex === 1) state.menuScroll = 0;
    } else if (down() && state.menuIndex < len(items)) {
      state.menuIndex = state.menuIndex + 1;
      if (state.menuIndex === 4) state.menuScroll = MENU_SCROLL_TILES;
    }
    return null;
  }

  if (state.phase === Boot.PHASE.MYSTERY_GIFT) {
    const pressed = (k: string): any => input && input.wasPressed && input.wasPressed(k);
    if (MysteryGiftUi.update(state.gift, pressed, dt) === "exit") {
      closeMysteryGift(state);
    }
    return null;
  }

  if (state.newGame && (state.phase === Boot.PHASE.CONTROLS || state.phase === Boot.PHASE.PIKACHU
      || state.phase === Boot.PHASE.OAK)) {
    const result = state.newGame.update(input, dt);
    const section = state.newGame.section;
    state.phase = (section === "pikachu" && Boot.PHASE.PIKACHU)
      || (section === "oak" && Boot.PHASE.OAK) || Boot.PHASE.CONTROLS;
    if (truthy(result)) {
      state.newGame.destroy();
      state.newGame = null;
      return result;
    }
    return null;
  }

  return null;
}

/** A colour sequence {r, g, b[, a]} (frlg_font's Col). */
const col = (...v: number[]): Col => seq(...v) as Col;

const MENU_BG = col(139 / 255, 148 / 255, 255 / 255); // pokefirered/graphics/main_menu/bg.pal:4
const MENU_TEXT = col(98 / 255, 98 / 255, 98 / 255, 1); // pokefirered/graphics/main_menu/textbox.pal:15
const MENU_SHADOW = col(213 / 255, 213 / 255, 205 / 255, 1); // pokefirered/graphics/main_menu/textbox.pal:16
const MENU_FILL = col(1, 1, 1, 1); // pokefirered/graphics/main_menu/textbox.pal:14
const ACCENT_MALE = col(4 / 31, 16 / 31, 31 / 31, 1);
const ACCENT_FEMALE = col(31 / 31, 3 / 31, 21 / 31, 1);
const WIN0V_CONTINUE = seq(seq(0x02, 0x5E), seq(0x62, 0x7E), seq(0x82, 0x9E), seq(0xA2, 0xBE));
const WIN0V_NOCONTINUE = seq(seq(0x02, 0x1E), seq(0x22, 0x3E));

// Lua: boot.lua:501
function darkenOutside(W: number, H: number, x0: number, y0: number, x1: number, y1: number): void {
  G.setColor(0, 0, 0, 7 / 16); // pokefirered/src/main_menu.c:231
  G.rectangle("fill", 0, 0, W, y0);
  G.rectangle("fill", 0, y1, W, H - y1);
  G.rectangle("fill", 0, y0, x0, y1 - y0);
  G.rectangle("fill", x1, y0, W - x1, y1 - y0);
}

// Lua: boot.lua:509
function drawMainMenu(state: any, W: number, H: number): void {
  G.clear(MENU_BG[1]!, MENU_BG[2]!, MENU_BG[3]!, 1); // pokefirered/src/main_menu.c:199
  const info = state.continueInfo ?? {};
  const head = { fg: MENU_TEXT, shadow: MENU_SHADOW, bg: MENU_FILL };
  const stat = {
    fg: (info.gender === 1) ? ACCENT_FEMALE : ACCENT_MALE, // pokefirered/src/main_menu.c:342
    shadow: MENU_SHADOW,
    bg: MENU_FILL,
  };
  const frameType = info.frameType ?? 0; // pokefirered/src/main_menu.c:680
  const x = 24;
  let y = 8;

  if (state.hasContinue) {
    const gift = hasMysteryGift(state);
    const scroll = (gift && state.menuIndex !== 1) ? (state.menuScroll ?? 0) : 0;
    const dy = scroll * 8;
    y = y - dy;
    Window.userFrame(Window.template(3, 1 - scroll, 24, 10), frameType); // pokefirered/src/main_menu.c:84
    Window.userFrame(Window.template(3, 13 - scroll, 24, 2), frameType); // pokefirered/src/main_menu.c:93
    Window.userFrame(Window.template(3, 17 - scroll, 24, 2), frameType); // pokefirered/src/main_menu.c:102
    if (gift) {
      Window.userFrame(Window.template(3, 21 - scroll, 24, 2), frameType);
    }
    Window.printPx(RomText.plain("gText_Continue"), x + 2, y + 2, { colors: head });
    Window.printPx(RomText.plain("gText_Player"), x + 2, y + 18, { colors: stat }); // pokefirered/src/main_menu.c:623
    Window.printPx(info.name ?? "", x + 62, y + 18, { colors: stat });
    Window.printPx(RomText.plain("gText_Time"), x + 2, y + 34, { colors: stat }); // pokefirered/src/main_menu.c:636
    Window.printPx(format("%d:%02d", info.hours ?? 0, info.minutes ?? 0), x + 62, y + 34, { colors: stat });
    if (info.hasDex) { // pokefirered/src/main_menu.c:648
      Window.printPx(RomText.plain("gText_Pokedex"), x + 2, y + 50, { colors: stat });
      Window.printPx(tostring(info.dexCount ?? 0), x + 62, y + 50, { colors: stat });
    }
    Window.printPx(RomText.plain("gText_Badges"), x + 2, y + 66, { colors: stat }); // pokefirered/src/main_menu.c:672
    Window.printPx(tostring(info.badges ?? 0), x + 62, y + 66, { colors: stat });
    Window.printPx(RomText.plain("gText_NewGame"), 24 + 2, 104 + 2 - dy, { colors: head });
    // pokefirered/src/main_menu.c:377 gText_MysteryGift
    Window.printPx(RomText.plain(gift ? "gText_MysteryGift" : "gText_MenuExit"),
      24 + 2, 136 + 2 - dy, { colors: head });
    if (gift) {
      Window.printPx(RomText.plain("gText_MenuExit"), 24 + 2, 168 + 2 - dy, { colors: head });
    }
    const rows = WIN0V_CONTINUE[state.menuIndex] ?? WIN0V_CONTINUE[1]!; // pokefirered/src/main_menu.c:565
    darkenOutside(W, H, 18, Math.max(0, rows[1]! - dy), 222, rows[2]! - dy);
    if (gift && scroll === 0) {
      ListMenu.drawArrow("down", W / 2, H - 8, Math.floor((state.blink ?? 0) * 60));
    }
  } else {
    Window.userFrame(Window.template(3, 1, 24, 2), frameType);
    Window.userFrame(Window.template(3, 5, 24, 2), frameType);
    Window.printPx(RomText.plain("gText_NewGame"), 24 + 2, 8 + 2, { colors: head });
    Window.printPx(RomText.plain("gText_MenuExit"), 24 + 2, 40 + 2, { colors: head });
    const rows = WIN0V_NOCONTINUE[state.menuIndex] ?? WIN0V_NOCONTINUE[1]!;
    darkenOutside(W, H, 18, rows[1]!, 222, rows[2]!);
  }

  const t = state.fadeT ?? 0;
  if (t > 0) {
    if (state.fadeColor === "white") {
      G.setColor(1, 1, 1, t / 16);
    } else {
      G.setColor(0, 0, 0, t / 16);
    }
    G.rectangle("fill", 0, 0, W, H);
  }
  G.setColor(1, 1, 1, 1);
}

// Lua: boot.lua:576
function drawSaveError(state: any, W: number, H: number): void {
  const e = state.saveError;
  G.clear(MENU_BG[1]!, MENU_BG[2]!, MENU_BG[3]!, 1);
  Window.stdFrame(Window.template(3, 15, 24, 4)); // pokefirered/src/main_menu.c:687
  const page = e.pages[e.page] ?? "";
  const limit = Math.min(e.revealed, FrlgFont.countChars(page));
  const [, endX, endY] = FrlgFont.draw(page, 24, 120 + 2, { // pokefirered/src/main_menu.c:603
    maxWidth: 192,
    limitChars: limit,
    colors: { fg: MENU_TEXT, shadow: MENU_SHADOW, bg: MENU_FILL },
  });
  if (e.waiting === "prompt" && e.arrowFrame != null && endX != null) {
    Chrome.promptArrow(endX, endY!, e.arrowFrame); // pokefirered/src/text.c:503
  }
  darkenOutside(W, H, 19, 115, 221, 157); // pokefirered/src/main_menu.c:606
  const t = state.fadeT ?? 0;
  if (t > 0) {
    G.setColor(1, 1, 1, t / 16);
    G.rectangle("fill", 0, 0, W, H);
  }
  G.setColor(1, 1, 1, 1);
}

// Lua: boot.lua:599
function draw(state: any): void {
  if (state.custom) return BootModules.draw(Boot, state);
  const W = Display.W, H = Display.H;
  G.clear(0, 0, 0, 1);

  if (state.phase === Boot.PHASE.INTRO && state.introMovie) {
    state.introMovie.draw();
    return;
  }

  if (state.phase === Boot.PHASE.TITLE || state.phase === Boot.PHASE.TITLE_CRY
      || state.phase === Boot.PHASE.TITLE_RESTART) {
    TitleScreen.draw(state);
    return;
  }

  if (state.phase === Boot.PHASE.MENU) {
    if (state.saveError) {
      drawSaveError(state, W, H);
    } else {
      drawMainMenu(state, W, H);
    }
    return;
  }

  if (state.phase === Boot.PHASE.MYSTERY_GIFT) {
    if (state.gift) MysteryGiftUi.draw(state.gift);
    return;
  }

  if (state.newGame) {
    state.newGame.draw();
  }
}

export const Boot = {
  PHASE,
  new: newBoot,
  setHasContinue,
  setContinueInfo,
  setSaveStatus,
  continueInfoFromSave,
  hasMysteryGift,
  menuItems,
  setTextSpeed,
  openMysteryGift,
  enterTitle,
  update,
  draw,
};

export default Boot;
