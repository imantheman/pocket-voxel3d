// Port of gen1recomp src/core/game3/trade_scene.lua (GPLv3 + additional terms; see LICENSE.md).
// The trade animation's state machine (in-game and link trades): the phase
// list, built once per (art, link, fadeIn) shape, stepped one frame at a time.
// ui/trade_scene.ts draws the state.
//
// Port notes:
// - `headless = not (type(love) == "table" and love.graphics)`: the platform
//   always has G, so a scene is never headless here (as on Brian's desktop).
// - pcall(require, "src.core.game3.audio") / "src.ui.game3.fade": both are in
//   the bundle and always load; the calls into them keep Brian's pcall.
// - pcall(require, "src.ui.game3.trade_scene"): the UI registers itself as
//   G3Lazy["src.ui.game3.trade_scene"]; a missing entry is the failed require.
// - package.loaded["src.ui.game3.evolution_scene"]: while that module is a
//   stub its isOpen throws NotPortedError, read as "not loaded" (nil).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { seq, len, ipairs } from "../platform/lt.ts";
import { tonumber, mod, truthy } from "../../../import/gen3/lua.ts";
import { NotPortedError } from "../notported.ts";
import { G3Lazy } from "./lazy_registry.ts";
import SE from "./se_ids.ts";
import RomText from "./rom_text.ts";
import Audio from "./audio.ts";
import Song from "./song_ids.ts";
import Rng from "./rng.ts";
import Pokemon from "./pokemon.ts";
import Fade from "../ui/fade.ts";
import EvolutionScene from "../ui/evolution_scene.ts";

/** The scene state (Brian's `s` table). */
export type TradeState = Record<string, any>;
export interface TradePhase { name: string; step: (s: TradeState) => boolean; only?: string }
/** A Lua sequence of phases (slot 0 unused). */
export type PhaseList = (TradePhase | null)[];

// pokefirered/include/constants/species.h:421
const SPECIES_EGG = 412;

// pokefirered/src/trade_scene.c:1119
const MON_SLIDE_HOFS = 0xB4;
// pokefirered/src/trade_scene.c:1355
const MON_SLIDE_STEP = 3;
// pokefirered/src/trade_scene.c:1377
const BYE_BYE_DELAY = 80;
// pokefirered/src/trade_scene.c:1379
const BALL_DEPART_DELAY = 0x14;
// pokefirered/src/data.c:133
const MON_RETURN_FRAMES = 18 + 15;
// pokefirered/src/pokeball.c:145
const BALL_CLOSE_FRAMES = 5 + 5;
// pokefirered/src/pokeball.c:1188
const BALL_TRADE_SE_AT = 11;
// pokefirered/src/trade_scene.c:2384
const BALL_DEPART_FRAMES = 44;
// pokefirered/src/trade_scene.c:2382
const BALL_DEPART_BOUNCE_AT = 22;
// pokefirered/src/trade_scene.c:2397
const BALL_DEPART_END_HOLD = 20;
// pokefirered/src/trade_scene.c:2400
const BALL_DEPART_END_FRAMES = 23;
// pokefirered/src/trade_scene.c:1398
const FADE_FRAMES = 16;
// pokefirered/src/trade_scene.c:1172
const ZOOM_MAX = 0x400;
// pokefirered/src/trade_scene.c:1419
const ZOOM_MIN = 0x100;
// pokefirered/src/trade_scene.c:1421
const ZOOM_STEP = 0x34;
// pokefirered/src/trade_scene.c:1194
const ZOOM_FAR = 0x80;
// pokefirered/src/trade_scene.c:1433
const GBA_FLASH_DELAY = 20;
// pokefirered/src/trade_scene.c:398
const FLASH_ANIM_FRAMES = 7 * 2 * 9;
// pokefirered/src/trade_scene.c:1128
const BG1_GBA_TOP = 0x15C;
// pokefirered/src/trade_scene.c:1452
const BG1_PAN_END = 316;
// pokefirered/src/trade_scene.c:1455
const CABLE_END_VOFS = 328;
// pokefirered/src/trade_scene.c:1465
const LINK_MON_TRAVEL_END = 166;
// pokefirered/src/trade_scene.c:1459
const LINK_MON_Y = 80;
// pokefirered/src/trade_scene.c:1475
const LINK_MON_OFFSCREEN = -8;
// pokefirered/src/trade_scene.c:1503
const CROSS_STEP = 3;
// pokefirered/src/trade_scene.c:1509
const CROSS_ENTER_LIMIT = -90;
// pokefirered/src/trade_scene.c:1570
const CROSS_EXIT_LIMIT = -222;
// pokefirered/src/trade_scene.c:1557
const CROSS_MON_LIMIT = -222;
// pokefirered/src/trade_scene.c:1493
const CROSS_MON_A_Y = 170;
// pokefirered/src/trade_scene.c:1494
const CROSS_MON_B_Y = -10;
// pokefirered/src/trade_scene.c:1584
const LINK_MON_ARRIVE_Y = -20;
// pokefirered/src/trade_scene.c:1604
const LINK_MON_ARRIVE_TARGET = 64;
// pokefirered/src/trade_scene.c:1625
const BG1_CENTER = 348;
// pokefirered/src/trade_scene.c:1621
const ARRIVED_DELAY = 10;
// pokefirered/src/trade_scene.c:1691
const BALL_ARRIVE_Y = -8;
// pokefirered/src/trade_scene.c:1692
const BALL_ARRIVE_TARGET = 74;
// pokefirered/src/trade_scene.c:2412
const BALL_ARRIVE_STEP = 4;
// pokefirered/src/trade_scene.c:2416
const BALL_ARRIVE_IDX = 22;
// pokefirered/src/trade_scene.c:2429
const BALL_ARRIVE_END = 108;
// pokefirered/src/trade_scene.c:1737
const MON_ANIM_DELAY = 60;
// pokefirered/src/trade_scene.c:1750
const FANFARE_AT = 10;
// pokefirered/src/trade_scene.c:1753
const TAKE_CARE_AT = 250;
// pokefirered/src/trade_scene.c:1762
const AFTER_MON_DELAY = 60;
// pokefirered/src/trade_scene.c:1552
const DISPLAY_HEIGHT = 160;
// pokefirered/src/trade_scene.c:2650
const LINK_SAVE_HOLD = 50;
// pokefirered/src/trade_scene.c:2653
const LINK_HOST_JITTER = 30;
// pokefirered/src/trade_scene.c:2699
const LINK_CLOSE_HOLD = 60;

const HOLD_FRAMES = 60;

// pokefirered/src/trade_scene.c:538 sTradeBallVerticalVelocityTable
// (Lua `{ [0] = 0, 0, 1, ... }`: index 0 is used, so this is a plain array.)
const BALL_VELOCITY: number[] = [
  0, 0, 1, 0,
  1, 0, 1, 1,
  1, 1, 2, 2,
  2, 2, 3, 3,
  3, 3, 4, 4,
  4, 4, -4, -4,
  -4, -3, -3, -3,
  -3, -2, -2, -2,
  -2, -1, -1, -1,
  -1, 0, -1, 0,
  -1, 0, 0, 0,
  0, 0, 1, 0,
  1, 0, 1, 1,
  1, 1, 2, 2,
  2, 2, 3, 3,
  3, 3, 4, 4,
  4, 4, -4, -3,
  -3, -2, -2, -1,
  -1, -1, 0, -1,
  0, 0, 0, 0,
  0, 0, 1, 0,
  1, 1, 1, 2,
  2, 3, 3, 4,
  -4, -3, -2, -1,
  -1, -1, 0, 0,
  0, 0, 1, 0,
  1, 1, 2, 3,
];

/** Lua's `a or b`. */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

// Lua: trade_scene.lua:141
function velocity(idx: number): number {
  return BALL_VELOCITY[idx] ?? 0;
}

// Lua: trade_scene.lua:145
function audioMod(): any {
  // pcall(require, "src.core.game3.audio"): always loads (see the port notes)
  const A: any = Audio;
  if (A != null && typeof A === "object") return A;
  return undefined;
}

/** pcall(f, ...) with the result dropped. */
function pcallDrop(f: (...a: any[]) => any, ...args: any[]): void {
  try { f(...args); } catch { /* pcall */ }
}

// Lua: trade_scene.lua:151
function playSe(s: TradeState, id: any): void {
  if (s.headless || id == null || id === false) return;
  const A = audioMod();
  if (A && A.playSe) pcallDrop(A.playSe, id);
}

// Lua: trade_scene.lua:158
// pokefirered/src/sound.c:124 GetCurrentMapMusic
function currentMapMusic(): any {
  const A = audioMod();
  if (!A) return undefined;
  if (A._mapSong != null && A._mapSong !== false) return A._mapSong;
  const cur = A._currentSong;
  return (cur != null && cur !== false) ? (cur.id ?? undefined) : undefined;
}

// Lua: trade_scene.lua:167
// pokefirered/src/sound.c:129 PlayNewMapMusic
function playNewMapMusic(s: TradeState, id: any): void {
  if (s.headless || id == null || id === false) return;
  const A = audioMod();
  if (A && A.playMapSong) {
    pcallDrop(A.playMapSong, id, { restart: true, loop: true });
  }
}

// Lua: trade_scene.lua:175
function playFanfare(s: TradeState, id: any): void {
  if (s.headless) return;
  const A = audioMod();
  if (A && A.playFanfare) pcallDrop(A.playFanfare, id);
}

// Lua: trade_scene.lua:181
function speciesOf(mon: any): number {
  return tonumber(mon ? (mon.species ?? mon.speciesId) : undefined) ?? 0;
}

// Lua: trade_scene.lua:185
function isEgg(mon: any): boolean {
  if (!mon) return false;
  if (mon.isEgg || mon.egg) return true;
  return speciesOf(mon) === SPECIES_EGG;
}

// Lua: trade_scene.lua:192
// pokefirered/src/trade_scene.c:1371
function playCry(s: TradeState, mon: any): void {
  if (s.headless || isEgg(mon)) return;
  const A = audioMod();
  if (A && A.playCry) {
    s.cryPlaying = true;
    pcallDrop(A.playCry, speciesOf(mon));
  }
}

// Lua: trade_scene.lua:202
// pokefirered/src/trade_scene.c:1746
function cryFinished(s: TradeState): boolean {
  if (s.headless || !s.cryPlaying) return true;
  const A = audioMod();
  if (!(A && A.isCryFinished)) return true;
  let done: any;
  try { done = A.isCryFinished(); } catch { return true; }
  return (done != null && done !== false) ? true : false;
}

// Lua: trade_scene.lua:213
// pokefirered/src/trade_scene.c:1239 GetMonData(MON_DATA_NICKNAME), which is
// gText_EggNickname for an egg (pokemon.c:3020)
function nameOf(mon: any): string {
  if (!mon) return "";
  if (isEgg(mon)) return RomText.plain("gText_EggNickname");
  const nick = mon.nickname ?? mon.name;
  if (typeof nick === "string" && nick !== "") return nick;
  // pcall(require, "src.core.game3.pokemon")
  if (Pokemon && Pokemon.name) {
    let n: any;
    try { n = Pokemon.name(speciesOf(mon)); } catch { n = undefined; }
    if (typeof n === "string") return n;
  }
  return "";
}

// Lua: trade_scene.lua:226
function otNameOf(mon: any): string {
  if (!mon) return "";
  const ot = mon.otName ?? mon.ot;
  if (typeof ot === "string" && ot !== "") return ot;
  return "";
}

// Lua: trade_scene.lua:234
// pokefirered/src/trade_scene.c:2808 DrawTextOnTradeWindow
function setText(s: TradeState, text: string | undefined): void {
  s.text = text ?? "";
}

// Lua: trade_scene.lua:239
// pokefirered/src/trade_scene.c:1238 TradeBufferOTnameAndNicknames
function tradeText(s: TradeState, key: string): string {
  return RomText.plain(key, { stringVars: seq(s.otName, s.sentName, s.recvName) });
}

// Lua: trade_scene.lua:243
function evolutionOpen(): boolean {
  // package.loaded["src.ui.game3.evolution_scene"] (see the port notes)
  const Scene: any = EvolutionScene;
  if (!(Scene && Scene.isOpen)) return false;
  try {
    return Scene.isOpen() ? true : false;
  } catch (e) {
    if (e instanceof NotPortedError) return false;
    throw e;
  }
}

// Lua: trade_scene.lua:248
function fade(s: TradeState, toBlack: boolean): void {
  if (s.headless) return;
  // pcall(require, "src.ui.game3.fade")
  const F: any = Fade;
  if (!(F && F.begin && F.MODE)) return;
  pcallDrop(F.begin, toBlack ? F.MODE.TO_BLACK : F.MODE.FROM_BLACK, 1, () => {});
}

const PHASES: PhaseList = seq<TradePhase>();
const INDEX: Record<string, number> = {};

// Lua: trade_scene.lua:258
function phase(name: string, step: (s: TradeState) => boolean, only?: string): void {
  PHASES[len(PHASES) + 1] = { name, step, only };
  INDEX[name] = len(PHASES);
}

// Lua: trade_scene.lua:264
// pokefirered/src/trade_scene.c:1054 TradeMons
function doSwap(s: TradeState): void {
  if (s.swapped) return;
  s.swapped = true;
  if (s.onSwap) s.onSwap(s.offer, s.received);
}

// Lua: trade_scene.lua:271
// pokefirered/src/trade.c:1297 CB_FadeToStartTrade
phase("fade_to_black", (s) => {
  fade(s, true);
  return true;
}, "fadein");

// Lua: trade_scene.lua:277
// pokefirered/src/trade.c:1301 CB_WaitToStartTrade
phase("wait_fade_to_black", (s) => {
  s.veil = s.frames / FADE_FRAMES;
  if (s.frames < FADE_FRAMES) return false;
  s.veil = 1;
  return true;
}, "fadein");

// Lua: trade_scene.lua:285
// pokefirered/src/trade_scene.c:1343
phase("start", (s) => {
  s.playerVisible = true;
  s.monX2 = -180;
  s.veil = 0;
  fade(s, false);
  // pokefirered/src/trade_scene.c:1348
  s.cachedMapMusic = currentMapMusic();
  // pokefirered/src/trade_scene.c:1349
  playNewMapMusic(s, Song.MUS_EVOLUTION);
  return true;
});

// Lua: trade_scene.lua:298
// pokefirered/src/trade_scene.c:1351
phase("mon_slide_in", (s) => {
  if (s.bg2hofs > 0) {
    s.monX2 = s.monX2 + MON_SLIDE_STEP;
    s.bg2hofs = s.bg2hofs - MON_SLIDE_STEP;
    return false;
  }
  s.monX2 = 0;
  s.bg2hofs = 0;
  return true;
});

// Lua: trade_scene.lua:310
// pokefirered/src/trade_scene.c:1366
phase("send_msg", (s) => {
  setText(s, tradeText(s, "gText_XWillBeSentToY"));
  playCry(s, s.offer);
  return true;
});

// Lua: trade_scene.lua:317
// pokefirered/src/trade_scene.c:1376
phase("bye_bye", (s) => {
  s.timer = s.timer + 1;
  if (s.timer !== BYE_BYE_DELAY) return false;
  setText(s, tradeText(s, "gText_ByeByeVar1"));
  s.ballVisible = true;
  s.ballX = 120; s.ballY = 32; s.ballY2 = 0;
  return true;
});

// Lua: trade_scene.lua:327
// pokefirered/src/trade_scene.c:1385
phase("pokeball_depart", (s) => {
  s.timer = s.timer + 1;
  if (s.timer <= BALL_DEPART_DELAY) return false;
  const t = s.timer - BALL_DEPART_DELAY - 1;
  if (t === BALL_TRADE_SE_AT) playSe(s, SE.SE_BALL_TRADE);
  if (t <= MON_RETURN_FRAMES) {
    s.monScale = 1 - (t / MON_RETURN_FRAMES);
    return false;
  }
  s.monScale = 0;
  s.playerVisible = false;
  return t >= MON_RETURN_FRAMES + BALL_CLOSE_FRAMES;
});

// Lua: trade_scene.lua:342
// pokefirered/src/trade_scene.c:2379
phase("pokeball_depart_wait", (s) => {
  if (s.ballStage !== "end") {
    s.ballY2 = s.ballY2 + velocity(s.ballIdx);
    if (s.ballIdx === BALL_DEPART_BOUNCE_AT) playSe(s, SE.SE_BALL_BOUNCE_1);
    s.ballIdx = s.ballIdx + 1;
    if (s.ballIdx === BALL_DEPART_FRAMES) {
      playSe(s, SE.SE_M_MEGA_KICK);
      s.ballStage = "end";
      s.ballIdx = 0;
      s.ballHold = 0;
      s.ballWhite = 1;
    }
    return false;
  }
  // pokefirered/src/trade_scene.c:2397
  s.ballHold = s.ballHold + 1;
  if (s.ballHold <= BALL_DEPART_END_HOLD) return false;
  s.ballY2 = s.ballY2 - velocity(s.ballIdx);
  s.ballIdx = s.ballIdx + 1;
  if (s.ballIdx !== BALL_DEPART_END_FRAMES) return false;
  s.ballVisible = false;
  return true;
});

// Lua: trade_scene.lua:367
// pokefirered/src/trade_scene.c:1397
phase("fade_out_to_gba_send", (s) => {
  fade(s, true);
  s.veil = 0;
  return true;
});

// Lua: trade_scene.lua:374
// pokefirered/src/trade_scene.c:1401
phase("wait_fade_out_to_gba_send", (s) => {
  s.veil = s.frames / FADE_FRAMES;
  if (s.frames < FADE_FRAMES) return false;
  s.veil = 1;
  setText(s, "");
  // pokefirered/src/trade_scene.c:1404
  s.monShadowBg = false;
  // pokefirered/src/trade_scene.c:1166
  s.bg2Zoom = ZOOM_MAX;
  return true;
});

const ART_FIRST = "fade_in_to_gba_send";

// Lua: trade_scene.lua:389
// pokefirered/src/trade_scene.c:1410
phase("fade_in_to_gba_send", (s) => {
  s.gbaVisible = true;
  fade(s, false);
  return true;
});

// Lua: trade_scene.lua:396
// pokefirered/src/trade_scene.c:1414
phase("wait_fade_in_to_gba_send", (s) => {
  s.veil = 1 - (s.frames / FADE_FRAMES);
  if (s.frames < FADE_FRAMES) return false;
  s.veil = 0;
  return true;
});

// Lua: trade_scene.lua:404
// pokefirered/src/trade_scene.c:1418
phase("gba_zoom_out", (s) => {
  if (s.bg2Zoom > ZOOM_MIN) {
    s.bg2Zoom = s.bg2Zoom - ZOOM_STEP;
    return false;
  }
  // pokefirered/src/trade_scene.c:1126
  s.bg1vofs = BG1_GBA_TOP;
  s.bg2Zoom = ZOOM_FAR;
  s.timer = 0;
  return true;
});

// Lua: trade_scene.lua:417
// pokefirered/src/trade_scene.c:1432
phase("gba_flash_send", (s) => {
  s.timer = s.timer + 1;
  if (s.timer <= GBA_FLASH_DELAY) return false;
  s.flash = 0;
  return true;
});

// Lua: trade_scene.lua:425
// pokefirered/src/trade_scene.c:1440
phase("gba_stop_flash_send", (s) => {
  s.flash = s.frames;
  if (s.frames < FLASH_ANIM_FRAMES) return false;
  s.flash = undefined;
  return true;
});

// Lua: trade_scene.lua:433
// pokefirered/src/trade_scene.c:1451
phase("pan_away_gba", (s) => {
  s.bg1vofs = s.bg1vofs - 1;
  if (s.bg1vofs === CABLE_END_VOFS) s.cableEnd = true;
  return s.bg1vofs === BG1_PAN_END;
});

// Lua: trade_scene.lua:440
// pokefirered/src/trade_scene.c:1458
phase("create_link_mon_leaving", (s) => {
  s.linkVisible = true;
  s.linkY = LINK_MON_Y;
  s.linkY2 = 0;
  return true;
});

// Lua: trade_scene.lua:448
// pokefirered/src/trade_scene.c:1464
phase("link_mon_travel_out", (s) => {
  s.bg1vofs = s.bg1vofs - 2;
  return s.bg1vofs === LINK_MON_TRAVEL_END;
});

// Lua: trade_scene.lua:454
// pokefirered/src/trade_scene.c:1472
phase("link_mon_travel_offscreen", (s) => {
  s.linkY = s.linkY - 2;
  return s.linkY < LINK_MON_OFFSCREEN;
});

// Lua: trade_scene.lua:460
// pokefirered/src/trade_scene.c:1478
phase("fade_out_to_crossing", (s) => {
  fade(s, true);
  return true;
});

// Lua: trade_scene.lua:466
// pokefirered/src/trade_scene.c:1482
phase("wait_fade_out_to_crossing", (s) => {
  s.veil = s.frames / FADE_FRAMES;
  if (s.frames < FADE_FRAMES) return false;
  s.veil = 1;
  s.linkVisible = false;
  s.gbaVisible = false;
  s.cableEnd = false;
  s.bg1vofs = 0;
  s.cableCloseup = true;
  return true;
});

// Lua: trade_scene.lua:479
// pokefirered/src/trade_scene.c:1491
phase("fade_in_to_crossing", (s) => {
  fade(s, false);
  s.crossVisible = true;
  s.crossY2a = 0; s.crossY2b = 0;
  return true;
});

// Lua: trade_scene.lua:487
// pokefirered/src/trade_scene.c:1497
phase("wait_fade_in_to_crossing", (s) => {
  s.crossY2a = s.crossY2a - CROSS_STEP;
  s.crossY2b = s.crossY2b + CROSS_STEP;
  s.veil = 1 - (s.frames / FADE_FRAMES);
  if (s.frames < FADE_FRAMES) return false;
  s.veil = 0;
  playSe(s, SE.SE_WARP_OUT);
  return true;
});

// Lua: trade_scene.lua:498
// pokefirered/src/trade_scene.c:1506
phase("crossing_link_mons_enter", (s) => {
  s.crossY2a = s.crossY2a - CROSS_STEP;
  s.crossY2b = s.crossY2b + CROSS_STEP;
  return s.crossY2a <= CROSS_ENTER_LIMIT;
});

// Lua: trade_scene.lua:505
// pokefirered/src/trade_scene.c:1516
phase("crossing_blend_white_1", (s) => {
  s.whiteBlend = 1;
  return true;
});

// Lua: trade_scene.lua:511
// pokefirered/src/trade_scene.c:1520
phase("crossing_blend_white_2", (s) => {
  s.whiteBlend = 0;
  return true;
});

// Lua: trade_scene.lua:517
// pokefirered/src/trade_scene.c:1524
phase("crossing_blend_white_3", (s) => {
  s.whiteBlend = 1;
  return true;
});

// Lua: trade_scene.lua:523
// pokefirered/src/trade_scene.c:1528
phase("crossing_create_mon_pics", (s) => {
  s.crossMonVisible = true;
  s.monY2a = 0; s.monY2b = 0;
  return true;
});

// Lua: trade_scene.lua:530
// pokefirered/src/trade_scene.c:1549
phase("crossing_mon_pics_move", (s) => {
  s.monY2a = s.monY2a - CROSS_STEP;
  s.monY2b = s.monY2b + CROSS_STEP;
  if (s.monY2a < -DISPLAY_HEIGHT && s.monY2a >= -DISPLAY_HEIGHT - CROSS_STEP) {
    playSe(s, SE.SE_WARP_IN);
  }
  if (s.monY2a >= CROSS_MON_LIMIT) return false;
  s.crossMonVisible = false;
  s.whiteBlend = 0;
  return true;
});

// Lua: trade_scene.lua:543
// pokefirered/src/trade_scene.c:1567
phase("crossing_link_mons_exit", (s) => {
  s.crossY2a = s.crossY2a - CROSS_STEP;
  s.crossY2b = s.crossY2b + CROSS_STEP;
  if (s.crossY2a > CROSS_EXIT_LIMIT) return false;
  fade(s, true);
  s.crossVisible = false;
  return true;
});

// Lua: trade_scene.lua:553
// pokefirered/src/trade_scene.c:1578
phase("create_link_mon_arriving", (s) => {
  s.veil = s.frames / FADE_FRAMES;
  if (s.frames < FADE_FRAMES) return false;
  s.veil = 1;
  s.cableCloseup = false;
  s.gbaVisible = true;
  s.bg1vofs = LINK_MON_TRAVEL_END;
  s.linkVisible = true;
  s.linkY = LINK_MON_ARRIVE_Y;
  s.linkY2 = 0;
  return true;
});

// Lua: trade_scene.lua:567
// pokefirered/src/trade_scene.c:1589
phase("fade_out_to_gba_recv", (s) => {
  fade(s, false);
  return true;
});

// Lua: trade_scene.lua:573
// pokefirered/src/trade_scene.c:1593
phase("wait_fade_out_to_gba_recv", (s) => {
  s.veil = 1 - (s.frames / FADE_FRAMES);
  if (s.frames < FADE_FRAMES) return false;
  s.veil = 0;
  return true;
});

// Lua: trade_scene.lua:581
// pokefirered/src/trade_scene.c:1601
phase("link_mon_travel_in", (s) => {
  s.linkY2 = s.linkY2 + CROSS_STEP;
  return s.linkY2 + s.linkY === LINK_MON_ARRIVE_TARGET;
});

// Lua: trade_scene.lua:587
// pokefirered/src/trade_scene.c:1607
phase("pan_to_gba", (s) => {
  s.bg1vofs = s.bg1vofs + 2;
  if (s.bg1vofs <= BG1_PAN_END) return false;
  s.bg1vofs = BG1_PAN_END;
  return true;
});

// Lua: trade_scene.lua:595
// pokefirered/src/trade_scene.c:1614
phase("destroy_link_mon", (s) => {
  s.linkVisible = false;
  s.timer = 0;
  return true;
});

// Lua: trade_scene.lua:602
// pokefirered/src/trade_scene.c:1620
phase("link_mon_arrived_delay", (s) => {
  s.timer = s.timer + 1;
  return s.timer === ARRIVED_DELAY;
});

// Lua: trade_scene.lua:608
// pokefirered/src/trade_scene.c:1624
phase("move_gba_to_center", (s) => {
  s.bg1vofs = s.bg1vofs + 1;
  if (s.bg1vofs === CABLE_END_VOFS) s.cableEnd = true;
  if (s.bg1vofs <= BG1_CENTER) return false;
  s.bg1vofs = BG1_CENTER;
  return true;
});

// Lua: trade_scene.lua:617
// pokefirered/src/trade_scene.c:1636
phase("gba_flash_recv", (s) => {
  s.flash = 0;
  return true;
});

// Lua: trade_scene.lua:623
// pokefirered/src/trade_scene.c:1640
phase("gba_stop_flash_recv", (s) => {
  s.flash = s.frames;
  if (s.frames < FLASH_ANIM_FRAMES) return false;
  s.flash = undefined;
  // pokefirered/src/trade_scene.c:1188
  s.bg2Zoom = ZOOM_FAR;
  playSe(s, SE.SE_M_SAND_ATTACK);
  return true;
});

// Lua: trade_scene.lua:634
// pokefirered/src/trade_scene.c:1649
phase("gba_zoom_in", (s) => {
  if (s.bg2Zoom < ZOOM_MAX) {
    s.bg2Zoom = s.bg2Zoom + ZOOM_STEP;
    return false;
  }
  s.bg2Zoom = ZOOM_MAX;
  return true;
});

// Lua: trade_scene.lua:644
// pokefirered/src/trade_scene.c:1661
phase("fade_out_to_new_mon", (s) => {
  fade(s, true);
  return true;
});

// Lua: trade_scene.lua:650
// pokefirered/src/trade_scene.c:1666
phase("wait_fade_out_to_new_mon", (s) => {
  s.veil = s.frames / FADE_FRAMES;
  if (s.frames < FADE_FRAMES) return false;
  s.veil = 1;
  s.gbaVisible = false;
  // pokefirered/src/trade_scene.c:1670
  s.monShadowBg = true;
  s.bg2hofs = 0;
  return true;
});

const ART_LAST = "wait_fade_out_to_new_mon";

// Lua: trade_scene.lua:664
// pokefirered/src/trade_scene.c:1675
phase("fade_in_to_new_mon", (s) => {
  fade(s, false);
  return true;
});

// Lua: trade_scene.lua:670
// pokefirered/src/trade_scene.c:1680
phase("wait_fade_in_to_new_mon", (s) => {
  s.veil = 1 - (s.frames / FADE_FRAMES);
  if (s.frames < FADE_FRAMES) return false;
  s.veil = 0;
  return true;
});

// Lua: trade_scene.lua:678
// pokefirered/src/trade_scene.c:1690
phase("pokeball_arrive", (s) => {
  s.ballVisible = true;
  s.ballX = 120; s.ballY = BALL_ARRIVE_Y; s.ballY2 = 0;
  s.ballIdx = 0;
  s.ballStage = "fall";
  s.ballWhite = 1;
  s.timer = 0;
  return true;
});

// Lua: trade_scene.lua:689
// pokefirered/src/trade_scene.c:1700
phase("fade_pokeball_to_normal", (s) => {
  s.ballWhite = 0;
  return true;
});

// Lua: trade_scene.lua:695
// pokefirered/src/trade_scene.c:2408
phase("pokeball_arrive_wait", (s) => {
  if (s.ballStage === "fall") {
    s.ballY = s.ballY + BALL_ARRIVE_STEP;
    if (s.ballY > BALL_ARRIVE_TARGET) {
      s.ballStage = "bounce";
      s.ballIdx = BALL_ARRIVE_IDX;
      playSe(s, SE.SE_BALL_BOUNCE_1);
    }
    return false;
  }
  if (s.ballIdx === 66) playSe(s, SE.SE_BALL_BOUNCE_2);
  if (s.ballIdx === 92) playSe(s, SE.SE_BALL_BOUNCE_3);
  if (s.ballIdx === 107) playSe(s, SE.SE_BALL_BOUNCE_4);
  s.ballY2 = s.ballY2 + velocity(s.ballIdx);
  s.ballIdx = s.ballIdx + 1;
  return s.ballIdx === BALL_ARRIVE_END;
});

// Lua: trade_scene.lua:714
// pokefirered/src/trade_scene.c:1714
phase("show_new_mon", (s) => {
  s.ballVisible = false;
  s.partnerVisible = true;
  return true;
});

// Lua: trade_scene.lua:721
// pokefirered/src/trade_scene.c:1725
phase("new_mon_msg", (s) => {
  setText(s, tradeText(s, "gText_XSentOverY"));
  s.timer = 0;
  return true;
});

// Lua: trade_scene.lua:728
// pokefirered/src/trade_scene.c:1736
phase("delay_for_mon_anim", (s) => {
  s.timer = s.timer + 1;
  if (s.timer <= MON_ANIM_DELAY) return false;
  playCry(s, s.received);
  s.timer = 0;
  return true;
});

// Lua: trade_scene.lua:737
// pokefirered/src/trade_scene.c:1745
phase("wait_for_mon_cry", (s) => {
  return cryFinished(s);
});

// Lua: trade_scene.lua:742
// pokefirered/src/trade_scene.c:1749
phase("take_care_of_mon", (s) => {
  s.timer = s.timer + 1;
  if (s.timer === FANFARE_AT) playFanfare(s, Song.MUS_EVOLVED);
  if (s.timer !== TAKE_CARE_AT) return false;
  setText(s, tradeText(s, "gText_TakeGoodCareOfX"));
  s.timer = 0;
  return true;
});

// Lua: trade_scene.lua:752
// pokefirered/src/trade_scene.c:1761
phase("after_new_mon_delay", (s) => {
  s.timer = s.timer + 1;
  return s.timer === AFTER_MON_DELAY;
});

// Lua: trade_scene.lua:758
// pokefirered/src/trade_scene.c:1765
phase("check_ribbons", (s) => {
  if (s.onRibbons) s.onRibbons(s.received);
  return true;
});

// Lua: trade_scene.lua:764
// pokefirered/src/trade_scene.c:1769
phase("end_link_trade", (s) => {
  if (s.link) {
    // pokefirered/src/trade_scene.c:2533 CB2_UpdateLinkTrade
    doSwap(s);
    return true;
  }
  if (s.headless || !s.needsConfirm) return true;
  if (!s.aPressed) return false;
  s.aPressed = false;
  return true;
});

// Lua: trade_scene.lua:777
// pokefirered/src/trade_scene.c:2344
phase("link_wait_peer", (s) => {
  if (!s.awaitPeer) return true;
  return s.peerConfirmed === true;
}, "link");

// Lua: trade_scene.lua:783
// pokefirered/src/trade_scene.c:1775
phase("try_evolution", (s) => {
  // pokefirered/src/trade_scene.c:1776
  doSwap(s);
  if (!s.evolved) {
    s.evolved = true;
    // pokefirered/src/trade_scene.c:2322 CB2_TryLinkTradeEvolution
    if (s.onEvolve) s.onEvolve(s.received);
  }
  return true;
});

// Lua: trade_scene.lua:794
phase("wait_evolution", (_s) => {
  return !evolutionOpen();
});

// Lua: trade_scene.lua:799
// pokefirered/src/trade_scene.c:2572
phase("link_standby", (s) => {
  setText(s, RomText.plain("gText_CommunicationStandby4"));
  if (!s.awaitSave) return true;
  return s.linkTaskDone === true;
}, "link");

// Lua: trade_scene.lua:806
// pokefirered/src/trade_scene.c:2595
phase("link_save", (s) => {
  setText(s, tradeText(s, "gText_SavingDontTurnOffThePower2"));
  if (!s.awaitSave) return true;
  return s.saveDone === true;
}, "link");

// Lua: trade_scene.lua:813
// pokefirered/src/trade_scene.c:2649
phase("link_save_delay", (s) => {
  s.timer = s.timer + 1;
  if (s.timer <= LINK_SAVE_HOLD) return false;
  if (s.hostJitter == null) {
    // pokefirered/src/trade_scene.c:2652
    s.hostJitter = s.linkHost ? mod(Rng.Random(), LINK_HOST_JITTER) : 0;
    return false;
  }
  // pokefirered/src/trade_scene.c:2659
  if (s.hostJitter > 0) {
    s.hostJitter = s.hostJitter - 1;
    return false;
  }
  return true;
}, "link");

// Lua: trade_scene.lua:830
// pokefirered/src/trade_scene.c:2698
phase("link_close_delay", (s) => {
  s.timer = s.timer + 1;
  return s.timer > LINK_CLOSE_HOLD;
}, "link");

// Lua: trade_scene.lua:836
// pokefirered/src/trade_scene.c:1783
phase("fade_out_end", (s) => {
  fade(s, true);
  return true;
});

// Lua: trade_scene.lua:842
// pokefirered/src/trade_scene.c:1787
phase("wait_fade_out_end", (s) => {
  s.veil = s.frames / FADE_FRAMES;
  if (s.frames < FADE_FRAMES) return false;
  s.veil = 1;
  // pokefirered/src/trade_scene.c:1790, :2290
  playNewMapMusic(s, s.cachedMapMusic);
  return true;
});

// Lua: trade_scene.lua:853
const HOLD_PHASE: TradePhase = {
  name: "hold",
  step: (s) => {
    s.veil = 1;
    return s.frames >= HOLD_FRAMES;
  },
};

// Lua: trade_scene.lua:858
function buildSequence(hasArt: boolean, link: boolean, fadeIn: boolean): PhaseList {
  const flags: Record<string, boolean> = { link: link ? true : false, fadein: fadeIn ? true : false };
  const out: PhaseList = seq<TradePhase>();
  let skipping = false;
  for (const [, ph] of ipairs<TradePhase>(PHASES)) {
    if (ph.name === TradeScene.ART_FIRST && !hasArt) {
      skipping = true;
      out[len(out) + 1] = HOLD_PHASE;
    }
    const wanted = (ph.only == null) || (flags[ph.only] === true);
    if (!skipping && wanted) out[len(out) + 1] = ph;
    if (ph.name === TradeScene.ART_LAST && skipping) skipping = false;
  }
  return out;
}

const SEQUENCES: Record<number, PhaseList> = {};

// Lua: trade_scene.lua:946
function uiMod(): any {
  // pcall(require, "src.ui.game3.trade_scene") (see the port notes)
  const Ui = G3Lazy["src.ui.game3.trade_scene"];
  if (Ui != null && typeof Ui === "object") return Ui;
  return undefined;
}

// Lua: trade_scene.lua:952
function finish(s: TradeState): void {
  TradeScene.open = false;
  TradeScene._s = undefined;
  if (!s.headless) {
    const Ui = uiMod();
    if (Ui && Ui.close) pcallDrop(Ui.close);
    fade(s, false);
  }
  if (s.onDone) s.onDone(s.received);
}

export const TradeScene = {
  FADE_FRAMES,
  HOLD_FRAMES,
  BALL_VELOCITY,
  ART_FIRST,
  ART_LAST,
  PHASES,
  open: false as boolean,
  _s: undefined as TradeState | undefined,

  // Lua: trade_scene.lua:876
  sequence(hasArt: any, link: any, fadeIn: any): PhaseList {
    const key = (hasArt ? 1 : 0) + (link ? 2 : 0) + (fadeIn ? 4 : 0);
    let sq = SEQUENCES[key];
    if (!sq) {
      sq = buildSequence(!!hasArt, !!link, !!fadeIn);
      SEQUENCES[key] = sq;
    }
    return sq;
  },

  // Lua: trade_scene.lua:886
  isOpen(): boolean {
    return TradeScene.open === true;
  },

  // Lua: trade_scene.lua:890
  state(): TradeState | undefined {
    return TradeScene._s;
  },

  // Lua: trade_scene.lua:894
  phase(): string | undefined {
    const s = TradeScene._s;
    if (!s) return undefined;
    const ph = s.phases[s.phaseIndex];
    return ph ? ph.name : undefined;
  },

  // Lua: trade_scene.lua:901
  hasArt(): boolean {
    const s = TradeScene._s;
    return (s && s.art != null && s.art !== false) ? true : false;
  },

  // Lua: trade_scene.lua:907
  // pokefirered/src/trade_scene.c:1772
  pressA(): void {
    const s = TradeScene._s;
    if (s && TradeScene.phase() === "end_link_trade") s.aPressed = true;
  },

  // Lua: trade_scene.lua:912
  isLink(): boolean {
    const s = TradeScene._s;
    return (s && s.link) ? true : false;
  },

  // Lua: trade_scene.lua:917
  peer(): any {
    const s = TradeScene._s;
    return s ? (s.peer ?? undefined) : undefined;
  },

  // Lua: trade_scene.lua:923
  // pokefirered/src/trade_scene.c:885 QuestLogEvent_Traded
  questLogData(): any {
    const s = TradeScene._s;
    return s ? (s.questLog ?? undefined) : undefined;
  },

  // Lua: trade_scene.lua:929
  // pokefirered/src/trade_scene.c:2344 LINKCMD_CONFIRM_FINISH_TRADE
  peerConfirmed(): void {
    const s = TradeScene._s;
    if (s) s.peerConfirmed = true;
  },

  // Lua: trade_scene.lua:935
  // pokefirered/src/trade_scene.c:2586 IsLinkTaskFinished
  linkTaskDone(): void {
    const s = TradeScene._s;
    if (s) s.linkTaskDone = true;
  },

  // Lua: trade_scene.lua:941
  // pokefirered/src/trade_scene.c:2628 LinkFullSave_WriteSector
  saveDone(): void {
    const s = TradeScene._s;
    if (s) s.saveDone = true;
  },

  // Lua: trade_scene.lua:964
  // pokefirered/src/trade_scene.c:951 CB2_InitInGameTrade
  play(offer: any, received: any, onDone?: ((received: any) => void) | null, optsIn?: any): boolean {
    const opts = optsIn ?? {};
    // `not (type(love) == "table" and love.graphics)`: G is always present.
    const headless = false;
    const s: TradeState = {
      offer,
      received,
      onDone: onDone ?? undefined,
      onSwap: opts.onSwap,
      onEvolve: opts.onEvolve,
      onRibbons: opts.onRibbons,
      peer: opts.peer,
      link: truthy(lor(opts.link, opts.peer)) ? true : false,
      linkHost: opts.linkHost ? true : false,
      awaitPeer: opts.awaitPeer ? true : false,
      awaitSave: opts.awaitSave ? true : false,
      // pokefirered/src/trade_scene.c:2527 CB2_UpdateLinkTrade
      uiDriven: opts.uiDriven ? true : false,
      headless,
      needsConfirm: !headless,
      art: opts.art,
      frames: 0,
      timer: 0,
      phaseIndex: 1,
      // pokefirered/src/trade_scene.c:1119
      bg2hofs: MON_SLIDE_HOFS,
      // pokefirered/src/trade_scene.c:1120
      monShadowBg: true,
      bg1vofs: BG1_GBA_TOP,
      // pokefirered/src/trade_scene.c:1172
      bg2Zoom: ZOOM_MAX,
      monX2: -180,
      monScale: 1,
      ballIdx: 0,
      ballHold: 0,
      ballStage: "depart",
      ballWhite: 0,
      veil: 0,
      text: "",
      crossY2a: 0,
      crossY2b: 0,
      monY2a: 0,
      monY2b: 0,
      crossMonAy: CROSS_MON_A_Y,
      crossMonBy: CROSS_MON_B_Y,
      swapped: false,
    };
    // pokefirered/src/trade_scene.c:1230 TradeBufferOTnameAndNicknames
    s.sentName = lor(opts.sentName, nameOf(offer));
    s.recvName = lor(opts.recvName, nameOf(received));
    s.otName = lor(lor(opts.otName, truthy(opts.peer) ? opts.peer.name : undefined), otNameOf(received));
    s.peerId = truthy(opts.peer) ? tonumber(lor(lor(opts.peer.id, opts.peer.trainerId), opts.peer.otId)) : undefined;
    // pokefirered/src/trade_scene.c:885
    s.questLog = {
      speciesSent: speciesOf(offer),
      speciesReceived: speciesOf(received),
      partnerName: s.otName,
      partnerId: s.peerId,
    };

    if (!headless) {
      const Ui = uiMod();
      if (Ui) {
        if (s.art == null && Ui.loadArt) {
          let art: any;
          try { art = Ui.loadArt(); } catch { art = undefined; }
          s.art = art ?? undefined;
        }
        if (Ui.start) pcallDrop(Ui.start, TradeScene);
      }
    }

    s.phases = TradeScene.sequence(s.art != null, s.link, opts.fadeIn);
    TradeScene._s = s;
    TradeScene.open = true;
    return true;
  },

  // Lua: trade_scene.lua:1041
  // pokefirered/src/trade_scene.c:1255 DoTradeAnim
  step(): boolean {
    const s = TradeScene._s;
    if (!s) return true;
    const ph: TradePhase | undefined = s.phases[s.phaseIndex];
    if (!ph) {
      finish(s);
      return true;
    }
    s.frames = s.frames + 1;
    if (ph.step(s)) {
      s.phaseIndex = s.phaseIndex + 1;
      s.frames = 0;
      s.timer = 0;
      if (!s.phases[s.phaseIndex]) {
        finish(s);
        return true;
      }
    }
    return false;
  },

  // Lua: trade_scene.lua:1062
  cancel(): void {
    const s = TradeScene._s;
    if (!s) return;
    TradeScene.open = false;
    TradeScene._s = undefined;
    if (!s.headless) {
      const Ui = uiMod();
      if (Ui && Ui.close) pcallDrop(Ui.close);
    }
  },
};

export default TradeScene;
