// Port of gen1recomp src/ui/game3/trainer_card.lua (GPLv3 + additional terms; see LICENSE.md).
// src/trainer_card.c

import { format, mod as luaMod, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { len, pairs, seq } from "../platform/lt.ts";
import { find, gmatch, gsub, match } from "../platform/lpattern.ts";
import { getNumKey, getStrKey } from "../shared/core/SaveSerializer.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type ImageData, type Quad } from "../platform/image.ts";
import { Fs } from "../platform/fs.ts";
import { Timer } from "../platform/timer.ts";
import { luaLoad } from "../platform/luadata.ts";
import { NotPortedError } from "../notported.ts";
import { Stack } from "./stack.ts";
import { FrlgFont } from "./frlg_font.ts";
import { RomText } from "../core/rom_text.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { Profile } from "../core/profile.ts";
import { Runtime } from "../core/runtime.ts";
import { Flags } from "../core/scripting/flags.ts";
import { Space } from "../core/scripting/space.ts";
import { Dex } from "../core/dex.ts";
import { Audio } from "../core/audio.ts";
import { Pokemon } from "../core/pokemon.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface InputLike { wasPressed(k: string): boolean }
interface CardText { id?: string; text: string; x: number; y: number; stat: boolean }
interface Flip { phase: "down" | "up"; top: number }

// src/trainer_card.c:224 sTrainerCardWindowTemplates[1] tilemapLeft 1, tilemapTop 1
const WIN_X = 8, WIN_Y = 8;

// src/trainer_card.c:1145 x = -122 - 6 * StringLength(buffer)
const CHAR_ADVANCE = 6;

let _badgesImg: Image | undefined;
let _badgeQuads: (Quad | null)[] | undefined;
let _starImg: Image | undefined;
let _stickersImg: Image | undefined;
let _stickerQuads: ((Quad | null)[] | null)[] | undefined;
let _picRed: Image | undefined;
let _picLeaf: Image | undefined;
let _cards: Record<string, Image | false> | undefined;
const _cardEdge: Record<string, number[]> = {};
let _screens: Record<string, Image | false> | undefined;
let _assetsTried = false;

/**
 * Lua's `pcall(require, "src.import.CacheFs")` followed by a call into it:
 * while CacheFs is still a stub it stands for a failed require.
 */
function viaCacheFs<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch (e) {
    if (e instanceof NotPortedError) return undefined;
    throw e;
  }
}

// Lua: trainer_card.lua:37
function read_cache_file(path: string): string | undefined {
  if (CacheFs) {
    if (CacheFs.readActive) {
      const data = viaCacheFs(() => CacheFs.readActive(path));
      if (data && data.length > 0) return data;
    }
    if (CacheFs.read) {
      const data = viaCacheFs(() => CacheFs.read(path));
      if (data && data.length > 0) return data;
    }
  }
  let d = Fs.read(path);
  if (d && d.length > 0) return d;
  const alt = "data/generated/gba/" + gsub(path, "^data/generated/gba/", "")[0];
  d = Fs.read(alt);
  if (d && d.length > 0) return d;
  // NOT FAITHFUL: io.open(path) -- no stdio on the 3DS; Fs above reads the same tree.
  return undefined;
}

// Lua: trainer_card.lua:64
function load_rgba_image(candidates: string[], w: number, h: number): [Image | undefined, string | undefined] {
  for (const p of candidates) {
    if (p.slice(-5) === ".rgba") {
      const raw = read_cache_file(p);
      if (raw && raw.length >= w * h * 4) {
        let imgData: ImageData | undefined;
        try { imgData = newImageData(w, h, "rgba8", raw); } catch { imgData = undefined; }
        if (imgData) {
          const img = G.newImage(imgData);
          if (img.setFilter) img.setFilter("nearest", "nearest");
          return [img, raw];
        }
      }
    } else {
      const bytes = read_cache_file(p);
      if (bytes && bytes.length > 0) {
        let img: Image | undefined;
        try {
          const fd = Fs.newFileData(bytes, (match(p, "[^/]+$") as string | undefined) || "img.png");
          const id = newImageData(fd);
          img = G.newImage(id);
          if (img.setFilter) img.setFilter("nearest", "nearest");
        } catch { img = undefined; }
        if (img) return [img, undefined];
      }
      let img: Image | undefined;
      try { img = G.newImage(p); } catch { img = undefined; }
      if (img) {
        if (img.setFilter) img.setFilter("nearest", "nearest");
        return [img, undefined];
      }
    }
  }
  return [undefined, undefined];
}

let _cardManifest: any;
// Lua: trainer_card.lua:105
function card_manifest(): any {
  if (_cardManifest) return _cardManifest;
  const src = read_cache_file("data/generated/gba/trainer_card/manifest.lua");
  const chunk = src ? luaLoad(src, "@trainer_card/manifest.lua")[0] : undefined;
  let ok = false, t: unknown;
  if (chunk) {
    try { t = chunk(); ok = true; } catch { ok = false; }
  }
  _cardManifest = ok && t != null && typeof t === "object" ? t : {};
  return _cardManifest;
}

// Lua: trainer_card.lua:116
function text(...keys: string[]): string | undefined {
  for (const key of keys) {
    if (RomText.has(key)) return RomText.plain(key);
  }
  return undefined;
}

// Lua: trainer_card.lua:124
function ensureAssets(): void {
  if (_assetsTried) return;
  _assetsTried = true;
  _cards = {};
  _screens = {};

  _badgesImg = load_rgba_image([
    "trainer_card/badges.rgba",
    "data/generated/gba/trainer_card/badges.rgba",
    "trainer_card/badges.png",
    "data/generated/gba/trainer_card/badges.png",
  ], 128, 16)[0];

  if (_badgesImg) {
    _badgeQuads = seq();
    const [iw, ih] = _badgesImg.getDimensions();
    for (let i = 0; i <= 7; i++) {
      _badgeQuads[i + 1] = G.newQuad(i * 16, 0, 16, 16, iw, ih);
    }
  }

  // src/trainer_card.c:1553 FillBgTilemapBufferRect(3, 143, ...) tile 143 + sTrainerCardStar_Pal
  _starImg = load_rgba_image([
    "trainer_card/star.rgba",
    "data/generated/gba/trainer_card/star.rgba",
  ], 8, 8)[0];

  // src/trainer_card.c:1454 PrintStickersOnCard, 4 sticker tiles x 4 palette slots
  _stickersImg = load_rgba_image([
    "trainer_card/stickers.rgba",
    "data/generated/gba/trainer_card/stickers.rgba",
  ], 64, 64)[0];

  if (_stickersImg) {
    _stickerQuads = seq();
    const [iw, ih] = _stickersImg.getDimensions();
    for (let pal = 1; pal <= 4; pal++) {
      const row: (Quad | null)[] = seq();
      _stickerQuads[pal] = row;
      for (let i = 1; i <= 3; i++) {
        row[i] = G.newQuad((i - 1) * 16, (pal - 1) * 16, 16, 16, iw, ih);
      }
    }
  }

  // src/trainer_card.c:293 sTrainerPicFacilityClasses[CARD_TYPE_FRLG]
  const pics = card_manifest().pics;
  if (pics != null && typeof pics === "object") {
    _picRed = load_rgba_image([format("data/generated/gba/trainers/front/%d.rgba", pics.male)], 64, 64)[0];
    _picLeaf = load_rgba_image([format("data/generated/gba/trainers/front/%d.rgba", pics.female)], 64, 64)[0];
  }
}

// src/trainer_card.c:1482 sKantoTrainerCardPals[stars] picks the card colour
// Lua: trainer_card.lua:173
function card_image(side: string, starsIn: unknown, female: boolean): Image | undefined {
  ensureAssets();
  if (!_cards) return undefined;
  const stars = Math.max(0, Math.min(4, tonumber(starsIn) ?? 0));
  const key = format("%s%d%s", side, stars, female ? "f" : "m");
  if (_cards[key] != null) return _cards[key] || undefined;

  const suffix = female ? "_female" : "";
  const names = [
    format("trainer_card/%s_%d%s.rgba", side, stars, suffix),
    format("data/generated/gba/trainer_card/%s_%d%s.rgba", side, stars, suffix),
  ];
  if (female) {
    names.push(format("trainer_card/%s_%d.rgba", side, stars));
    names.push(format("data/generated/gba/trainer_card/%s_%d.rgba", side, stars));
  }
  names.push("trainer_card/bg" + suffix + ".rgba");
  names.push("data/generated/gba/trainer_card/bg" + suffix + ".rgba");
  names.push("trainer_card/bg.rgba");
  names.push("data/generated/gba/trainer_card/bg.rgba");

  const [img, raw] = load_rgba_image(names, 240, 160);
  _cards[key] = img || false;
  if (raw && raw.length >= 4) {
    _cardEdge[key] = [
      raw.charCodeAt(0) / 255,
      raw.charCodeAt(1) / 255,
      raw.charCodeAt(2) / 255,
    ];
  }
  return img;
}

// src/trainer_card.c:1516 DrawCardScreenBackground keeps BG2 full size while BG0 flips
// Lua: trainer_card.lua:207
function screen_image(starsIn: unknown, female: boolean): Image | undefined {
  ensureAssets();
  if (!_screens) return undefined;
  const stars = Math.max(0, Math.min(4, tonumber(starsIn) ?? 0));
  const key = format("%d%s", stars, female ? "f" : "m");
  if (_screens[key] != null) return _screens[key] || undefined;

  const suffix = female ? "_female" : "";
  const names = [
    format("trainer_card/screen_%d%s.rgba", stars, suffix),
    format("data/generated/gba/trainer_card/screen_%d%s.rgba", stars, suffix),
  ];
  if (female) {
    names.push(format("trainer_card/screen_%d.rgba", stars));
    names.push(format("data/generated/gba/trainer_card/screen_%d.rgba", stars));
  }
  const img = load_rgba_image(names, 240, 160)[0];
  _screens[key] = img || false;
  return img;
}

// pokefirered/include/constants/flags.h:1364-1371
let BADGE_FLAGS: (number | null)[] = seq(0x820, 0x821, 0x822, 0x823, 0x824, 0x825, 0x826, 0x827);
let BADGE_NAMES: (string | null)[] = seq("BOULDER", "CASCADE", "THUNDER", "RAINBOW", "SOUL", "MARSH", "VOLCANO", "EARTH");
// Lua: trainer_card.lua:228 (a do-block at load time; here run on first use,
// as module scope may not read imports -- Profile is inside the import cycle)
let _badgeTableDone = false;
function ensure_badge_table(): void {
  if (_badgeTableDone) return;
  _badgeTableDone = true;
  let row: any;
  try { row = Profile.active(); } catch { row = undefined; }
  const badges = row != null && typeof row === "object" ? row.badges : undefined;
  if (badges != null && typeof badges === "object" && typeof badges.flagBase === "number"
      && badges.names != null && typeof badges.names === "object" && badges.count === len(badges.names)) {
    const flags: (number | null)[] = seq();
    for (let i = 1; i <= badges.count; i++) flags[i] = badges.flagBase + i - 1;
    BADGE_FLAGS = flags;
    BADGE_NAMES = badges.names;
  }
}

const FLAG_SYS_POKEDEX_GET = 0x829;
const FLAG_SYS_NATIONAL_DEX = 0x840;
// src/trainer_card.c:899
const VAR_TRAINER_CARD_MON_ICON_TINT_IDX = 0x4042;
const VAR_TRAINER_CARD_MON_ICON_1 = 0x4043;
const VAR_HOF_BRAG_STATE = 0x4049;
const VAR_EGG_BRAG_STATE = 0x404A;
const VAR_LINK_WIN_BRAG_STATE = 0x404B;

/** Lua `(tonumber(x) or 0) > 0`. */
function positive(x: unknown): boolean {
  return (tonumber(x) ?? 0) > 0;
}

// Lua: trainer_card.lua:251
function check_flags_table(flags: any, flagId: number, flagName?: string): boolean {
  if (!flags || typeof flags !== "object") return false;
  const n = getNumKey(flags, flagId);
  if (n === true || positive(n)) return true;
  const s = getStrKey(flags, flagId); // flags[tostring(flagId)]
  if (s === true || positive(s)) return true;
  const hex = format("0x%X", flagId);
  if (flags[hex] === true || positive(flags[hex])) return true;
  if (flagName && (flags[flagName] === true || positive(flags[flagName]))) return true;
  return false;
}

/** Lua s:lower() (C locale). */
function lower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

// Lua: trainer_card.lua:261
function is_badge_unlocked(session: any, badgeIndex: number | undefined): boolean {
  if (badgeIndex == null || badgeIndex < 1 || badgeIndex > 8) return false;
  ensure_badge_table();
  const flagId = BADGE_FLAGS[badgeIndex] ?? (0x820 + badgeIndex - 1);
  const bName = BADGE_NAMES[badgeIndex] ?? undefined;
  const flagName = format("FLAG_BADGE0%d_GET", badgeIndex);

  if (session) {
    if (session.badges) {
      const b = session.badges;
      if (typeof b === "object") {
        if (b[badgeIndex] === true || positive(b[badgeIndex])) {
          return true;
        }
        if (bName && (b[bName] === true || b[lower(bName)] === true
            || b[bName + "_BADGE"] === true || b[lower(bName + "_BADGE")] === true
            || positive(b[bName]))) {
          return true;
        }
        if (getNumKey(b, flagId) === true || getStrKey(b, flagId) === true || b[flagName] === true) {
          return true;
        }
      } else if (typeof b === "number") {
        const mask = 1 << (badgeIndex - 1);
        if ((b & mask) !== 0 || luaMod(Math.floor(b / mask), 2) === 1) {
          return true;
        }
      }
    }

    if (session["badge" + badgeIndex] === true || session["badge_" + badgeIndex] === true) return true;
    if (bName && (session[bName + "_BADGE"] === true || session[lower(bName + "_BADGE")] === true
        || session[bName] === true || session[lower(bName)] === true)) {
      return true;
    }

    if (check_flags_table(session.flags, flagId, flagName)) return true;

    if (session.store && check_flags_table(session.store.flags, flagId, flagName)) return true;

    const save = session.save || (session.game && session.game.save) || session;
    if (save && save.player && save.player.badges) {
      const pb = save.player.badges;
      if (pb[badgeIndex] === true || pb[flagId] === true || (bName && pb[bName] === true)) {
        return true;
      }
    }
    if (save && save.flags && check_flags_table(save.flags, flagId, flagName)) return true;
  }

  // package.loaded["src.core.game3.scripting.space"]
  const store = (Space && Space.getStore && Space.getStore()) || (Space && Space.store);
  if (store && check_flags_table(store.flags, flagId, flagName)) return true;

  if (Runtime && Runtime.getSession) {
    const rtSess = Runtime.getSession();
    if (rtSess && rtSess !== session) {
      if (check_flags_table(rtSess.flags, flagId, flagName)) return true;
      if (rtSess.store && check_flags_table(rtSess.store.flags, flagId, flagName)) return true;
    }
  }

  return false;
}

// Lua: trainer_card.lua:327
function script_store(): any {
  return (Space && Space.getStore && Space.getStore()) || (Space && Space.store);
}

// Lua: trainer_card.lua:332
function get_flag(session: any, flagId: number, flagName?: string): boolean {
  if (session && check_flags_table(session.flags, flagId, flagName)) return true;
  if (session && session.store && check_flags_table(session.store.flags, flagId, flagName)) return true;
  const store = script_store();
  if (store) {
    if (Flags && Flags.getFlag) {
      let ok = true, v: unknown;
      try { v = Flags.getFlag(store, null, flagId); } catch { ok = false; }
      if (ok && v === true) return true;
    }
    if (check_flags_table(store.flags, flagId, flagName)) return true;
  }
  return false;
}

// Lua: trainer_card.lua:347
function get_var(session: any, varId: number): number {
  const store = script_store();
  if (store) {
    if (Flags && Flags.getVar) {
      let ok = true, v: unknown;
      try { v = Flags.getVar(store, null, varId); } catch { ok = false; }
      if (ok) return tonumber(v) ?? 0;
    }
    if (store.vars != null && typeof store.vars === "object") return tonumber(store.vars[varId]) ?? 0;
  }
  if (session && session.vars != null && typeof session.vars === "object") {
    let v = getNumKey(session.vars, varId);
    if (v == null) v = getStrKey(session.vars, varId); // session.vars[tostring(varId)]
    return tonumber(v) ?? 0;
  }
  return 0;
}

// Lua: trainer_card.lua:366
function dex_caught(dex: any, sp: number): boolean {
  if (!dex) return false;
  if (Dex && Dex.isCaught) {
    let ok = true, v: unknown;
    try { v = Dex.isCaught(dex, sp); } catch { ok = false; }
    if (ok) return v === true;
  }
  return (dex.caught && dex.caught[sp]) === true;
}

// Lua: trainer_card.lua:376
function has_all_kanto(dex: any): boolean {
  if (!dex) return false;
  for (let sp = 1; sp <= 150; sp++) {
    if (!dex_caught(dex, sp)) return false;
  }
  return true;
}

// Lua: trainer_card.lua:384
function has_all_mons(dex: any): boolean {
  if (!has_all_kanto(dex)) return false;
  for (let sp = 152; sp <= 248; sp++) {
    if (!dex_caught(dex, sp)) return false;
  }
  for (let sp = 252; sp <= 384; sp++) {
    if (!dex_caught(dex, sp)) return false;
  }
  return true;
}

// Lua: trainer_card.lua:395
function caught_mons_count(session: any, national: boolean): number {
  const dex = session && session.dex;
  if (!dex) return 0;
  if (Dex && Dex.countCaught) {
    let ok = true, n: unknown;
    try { n = Dex.countCaught(dex, national ? "national" : "kanto"); } catch { ok = false; }
    if (ok && n != null && n !== false) return n as number;
  }
  let n = 0;
  for (const [, on] of pairs(dex.caught || {})) {
    if (on) n = n + 1;
  }
  return n;
}

// Lua: trainer_card.lua:410
function capped_stat(session: any, id: number, key: string, cap: number): number {
  const stats = session.gameStats;
  let v: unknown;
  if (stats != null && typeof stats === "object") {
    v = stats[id] ?? stats[key];
  } else {
    v = session[key];
  }
  return Math.min(cap, Math.max(0, Math.floor(tonumber(v) ?? 0)));
}

// src/trainer_card.c:858 TrainerCard_GenerateCardForLinkPlayer
// Lua: trainer_card.lua:422
function gather(sessionIn?: any): any {
  const session = sessionIn || {};
  const c: any = {};
  c.female = (session.gender === "female" || session.gender === "F" || session.gender === 1
    || session.playerGender === "female" || session.playerGender === 1) ? true : false;
  c.playerName = tostring(session.name || session.playerName || "RED");
  c.trainerId = luaMod(tonumber(session.trainerId ?? session.id ?? session.playerTrainerId) ?? 0, 65536);

  const pt = session.playtime || session.playTime;
  c.playTimeHours = Math.min(999, Math.max(0, Math.floor(
    tonumber(session.playTimeHours ?? session.hours ?? (pt ? pt.hours : undefined)) ?? 0)));
  c.playTimeMinutes = Math.min(59, Math.max(0, Math.floor(
    tonumber(session.playTimeMinutes ?? session.minutes ?? (pt ? pt.minutes : undefined)) ?? 0)));

  c.hofDebutHours = tonumber(session.hofDebutHours) ?? 0;
  c.hofDebutMinutes = tonumber(session.hofDebutMinutes) ?? 0;
  c.hofDebutSeconds = tonumber(session.hofDebutSeconds) ?? 0;
  if (c.hofDebutHours > 999) {
    c.hofDebutHours = 999; c.hofDebutMinutes = 59; c.hofDebutSeconds = 59;
  }

  c.hasPokedex = get_flag(session, FLAG_SYS_POKEDEX_GET, "FLAG_SYS_POKEDEX_GET");
  const national = get_flag(session, FLAG_SYS_NATIONAL_DEX, "FLAG_SYS_NATIONAL_DEX");
  c.caughtMonsCount = caught_mons_count(session, national);

  c.money = Math.max(0, Math.floor(tonumber(session.money) ?? 0));
  // src/trainer_card.c:822
  c.linkBattleWins = capped_stat(session, 23, "linkBattleWins", 9999);
  c.linkBattleLosses = capped_stat(session, 24, "linkBattleLosses", 9999);
  c.pokemonTrades = capped_stat(session, 21, "pokemonTrades", 0xFFFF);
  // src/trainer_card.c:876
  c.berryCrushPoints = capped_stat(session, 51, "berryCrushPoints", 0xFFFF);
  c.unionRoomNum = capped_stat(session, 50, "unionRoomNum", 0xFFFF);

  c.hasHofResult = (c.hofDebutHours !== 0 || c.hofDebutMinutes !== 0 || c.hofDebutSeconds !== 0);
  c.hasLinkResults = (c.linkBattleWins !== 0 || c.linkBattleLosses !== 0);
  c.hasTrades = (c.pokemonTrades !== 0);

  let stars = 0;
  if (c.hasHofResult) stars = 1;
  if (has_all_kanto(session.dex)) stars = stars + 1;
  if (has_all_mons(session.dex)) stars = stars + 1;
  const berries = tonumber(session.berriesPicked) ?? 0;
  const jumps = tonumber(session.jumpsInRow) ?? 0;
  if (berries >= 200 && jumps >= 200) stars = stars + 1;
  c.stars = Math.min(4, stars);

  // src/trainer_card.c:899
  c.monIconTint = get_var(session, VAR_TRAINER_CARD_MON_ICON_TINT_IDX);

  c.monSpecies = seq();
  for (let i = 1; i <= 6; i++) {
    c.monSpecies[i] = get_var(session, VAR_TRAINER_CARD_MON_ICON_1 + i - 1);
  }
  c.stickers = seq(
    get_var(session, VAR_HOF_BRAG_STATE),
    get_var(session, VAR_EGG_BRAG_STATE),
    get_var(session, VAR_LINK_WIN_BRAG_STATE),
  );

  c.badges = seq();
  for (let i = 1; i <= 8; i++) c.badges[i] = is_badge_unlocked(session, i);
  return c;
}

// Lua: trainer_card.lua:509
function play_se(name: string): void {
  if (!Audio) return;
  const fn = Audio.playSe || Audio.playSE;
  if (fn) {
    try { fn.call(Audio, name); } catch { /* pcall */ }
  }
}

// src/trainer_card.c:1700 Task_AnimateCardFlipDown +7 to 77, Task_AnimateCardFlipUp -5 to 0
const FLIP_TOP_MAX = 77;
const FLIP_DOWN_STEP = 7;
const FLIP_UP_STEP = 5;

// Lua: trainer_card.lua:525
function beginFlip(): void {
  TrainerCard._flip = { phase: "down", top: 0 };
  play_se("SE_CARD_FLIP");
}

const texts_cache: { c: any; colon: any; front: CardText[] | undefined; back: CardText[] | undefined } =
  { c: false, colon: false, front: undefined, back: undefined };
// Lua: trainer_card.lua:550
function front_texts_cached(c: any, colonInvisible: boolean): CardText[] {
  if (texts_cache.front && texts_cache.c === c && texts_cache.colon === colonInvisible) {
    return texts_cache.front;
  }
  texts_cache.c = c; texts_cache.colon = colonInvisible;
  texts_cache.front = TrainerCard.frontTexts(c, colonInvisible);
  return texts_cache.front!;
}
// Lua: trainer_card.lua:558
function back_texts_cached(c: any): CardText[] {
  if (texts_cache.back && texts_cache.c === c) return texts_cache.back;
  texts_cache.c = c;
  texts_cache.back = TrainerCard.backTexts(c);
  return texts_cache.back!;
}

// Lua: trainer_card.lua:565
function cardType(session: any): string {
  let row: any;
  try { row = Profile.forSession(session); } catch { row = undefined; }
  const tc = row && row.ui != null && typeof row.ui === "object" ? row.ui.trainerCard : undefined;
  return (tc && tc.cardType) || "frlg";
}

// Lua: trainer_card.lua:572
function gatherRse(_session: any): any {
  // NOT FAITHFUL: Emerald only -- the Emerald card (link/family, the Hoenn
  // dex, frontier symbols) is not ported; FRLG's cardType is "frlg".
  throw new Error("NOT FAITHFUL: Emerald only (trainer_card gatherRse)");
}

// Lua: trainer_card.lua:678
function right_align(n: number, width: number): string {
  let s = tostring(Math.floor(n));
  while (s.length < width) s = " " + s;
  return s;
}

// Lua: trainer_card.lua:684
function leading_zeros(n: number, width: number): string {
  return format("%0" + width + "d", Math.floor(n));
}

// Lua: trainer_card.lua:688
function str_length(s: unknown): number {
  let n = 0;
  for (const _ of gmatch(tostring(s), "[%z\x01-\x7F\xC2-\xF4][\x80-\xBF]*")) n = n + 1;
  return n;
}

// Lua: trainer_card.lua:771
function draw_texts(list: CardText[]): void {
  for (const e of list) {
    FrlgFont.draw(e.text, e.x, e.y, { colors: e.stat ? FrlgFont.COLOR.STAT : FrlgFont.COLOR.NORMAL });
  }
}

// Lua: trainer_card.lua:777
function draw_front(c: any): void {
  const pic = c.female ? (_picLeaf || _picRed) : (_picRed || _picLeaf);
  if (pic) {
    G.setColor(1, 1, 1, 1);
    G.draw(pic, WIN_X + 144 + 13, WIN_Y + 32 + 4);
  }

  draw_texts(front_texts_cached(c, TrainerCard._colonInvisible));

  // src/trainer_card.c:1553 stars at tile (15, 7), badges at tile (4 + 3i, 16)
  if (_starImg) {
    G.setColor(1, 1, 1, 1);
    for (let i = 0; i <= c.stars - 1; i++) {
      G.draw(_starImg, 120 + i * 8, 56);
    }
  }

  for (let i = 1; i <= 8; i++) {
    if (c.badges[i] && _badgesImg && _badgeQuads && _badgeQuads[i]) {
      G.setColor(1, 1, 1, 1);
      G.draw(_badgesImg, _badgeQuads[i], 32 + (i - 1) * 24, 128);
    }
  }
}

// src/trainer_card.c:1411, include/constants/trainer_card.h
const MON_ICON_TINT_BLACK = 1;
const MON_ICON_TINT_PINK = 2;
const MON_ICON_TINT_SEPIA = 3;

// pokefirered/src/palette.c:832
// Lua: trainer_card.lua:808
function tint_pixel(tint: number, r: number, g: number, b: number): [number, number, number] {
  const gray = 0.3 * r + 0.59 * g + 0.1133 * b;
  let nr: number, ng: number, nb: number;
  if (tint === MON_ICON_TINT_BLACK) {
    nr = 0; ng = 0; nb = 0;
  } else if (tint === MON_ICON_TINT_PINK) {
    nr = 500 * gray / 256; ng = 330 * gray / 256; nb = 310 * gray / 256;
  } else {
    nr = 1.2 * gray; ng = gray; nb = 0.94 * gray;
  }
  if (nr > 255) nr = 255;
  if (ng > 255) ng = 255;
  if (nb > 255) nb = 255;
  return [Math.floor(nr), Math.floor(ng), Math.floor(nb)];
}

const _tintedIcons: Record<number, Record<number, any>> = {};

// Lua: trainer_card.lua:827
function tinted_icon(icon: any, species: number, tintIn: number | undefined): any {
  if (!icon || !icon.image || tintIn == null) return icon;
  const tint = Math.floor(tintIn);
  if (tint < MON_ICON_TINT_BLACK || tint > MON_ICON_TINT_SEPIA) return icon;
  let byTint = _tintedIcons[tint];
  if (!byTint) {
    byTint = {};
    _tintedIcons[tint] = byTint;
  }
  const hit = byTint[species];
  if (hit != null) return hit || icon;

  const fail = (): any => {
    byTint![species] = false;
    return icon;
  };

  // icon.image:getData(): a love Image has none, so Brian's pcall fails here
  // too unless the icon's image carries one.
  let src: any;
  try { src = icon.image.getData(); } catch { return fail(); }
  if (!src || !src.getPixel) return fail();
  const w = src.getWidth(), h = src.getHeight();
  let dst: ImageData;
  try {
    dst = newImageData(w, h);
    for (let y = 0; y <= h - 1; y++) {
      for (let x = 0; x <= w - 1; x++) {
        const [r, g, b, a] = src.getPixel(x, y);
        const [nr, ng, nb] = tint_pixel(tint, r * 255, g * 255, b * 255);
        dst.setPixel(x, y, nr / 255, ng / 255, nb / 255, a);
      }
    }
  } catch { return fail(); }
  let img: Image;
  try { img = G.newImage(dst); } catch { return fail(); }
  if (img.setFilter) img.setFilter("nearest", "nearest");

  byTint[species] = {
    image: img,
    w: icon.w,
    h: icon.h,
    sheetH: icon.sheetH,
    frames: icon.frames,
    quads: icon.quads,
  };
  return byTint[species];
}

// Lua: trainer_card.lua:874
function draw_back(c: any): void {
  draw_texts(back_texts_cached(c));

  // src/trainer_card.c:1414 WriteSequenceToBgTilemapBuffer(3, .., 4i + 3, 15, 4, 4, ..)
  if (Pokemon && Pokemon.icon) {
    const tint = tonumber(c.monIconTint) ?? 0;
    for (let i = 1; i <= 6; i++) {
      const sp = c.monSpecies[i];
      if (sp && sp > 0) {
        const icon = tinted_icon(Pokemon.icon(sp), sp, tint);
        const q = icon && icon.quads && icon.quads[0];
        if (icon && icon.image && q) {
          G.setColor(1, 1, 1, 1);
          G.draw(icon.image, q, 24 + (i - 1) * 32, 120);
        }
      }
    }
  }

  // src/trainer_card.c:1454 WriteSequenceToBgTilemapBuffer(3, .., 3i + 2, 2, 2, 2, ..)
  if (_stickersImg && _stickerQuads) {
    for (let i = 1; i <= 3; i++) {
      const sticker = c.stickers[i] || 0;
      const quads = _stickerQuads[sticker];
      if (sticker >= 1 && sticker <= 4 && quads && quads[i]) {
        G.setColor(1, 1, 1, 1);
        G.draw(_stickersImg, quads[i], 16 + (i - 1) * 24, 16);
      }
    }
  }
}

// Lua: trainer_card.lua:970
function drawRse(_c: any): void {
  // NOT FAITHFUL: Emerald only -- rse/scene_kit is not ported.
  throw new Error("NOT FAITHFUL: Emerald only (trainer_card drawRse)");
}

export const TrainerCard: any = {
  isMenu: true,

  open: false,
  _session: undefined as any,
  _onClose: undefined as (() => void) | undefined,
  _card: undefined as any,
  _flip: undefined as Flip | undefined,
  _rse: false,
  _colonInvisible: false,

  side: "front",

  // Lua: trainer_card.lua:496
  isBadgeUnlocked(badgeIndex: number): boolean {
    return is_badge_unlocked(TrainerCard._session, badgeIndex);
  },

  // Lua: trainer_card.lua:500
  countBadges(session?: any): number {
    const s = session || TrainerCard._session;
    let n = 0;
    for (let i = 1; i <= 8; i++) {
      if (is_badge_unlocked(s, i)) n = n + 1;
    }
    return n;
  },

  // Lua: trainer_card.lua:521
  flip(): void {
    TrainerCard.side = (TrainerCard.side === "back") ? "front" : "back";
  },

  // Lua: trainer_card.lua:530
  update(_dt?: number): void {
    const f: Flip | undefined = TrainerCard._flip;
    if (!f) return;
    if (f.phase === "down") {
      f.top = f.top + FLIP_DOWN_STEP;
      if (f.top >= FLIP_TOP_MAX) {
        f.top = FLIP_TOP_MAX;
        f.phase = "up";
        TrainerCard.flip();
        play_se("SE_CARD_FLIPPING");
      }
    } else {
      f.top = f.top - FLIP_UP_STEP;
      if (f.top <= 0) {
        TrainerCard._flip = undefined;
        play_se("SE_CARD_OPEN");
      }
    }
  },

  // Lua: trainer_card.lua:630
  show(opts?: any): void {
    opts = opts || {};
    TrainerCard.open = true;
    TrainerCard.side = "front";
    TrainerCard._flip = undefined;
    TrainerCard._session = opts.session;
    TrainerCard._rse = cardType(opts.session) === "emerald";
    TrainerCard._card = TrainerCard._rse ? gatherRse(opts.session) : gather(opts.session);
    texts_cache.c = false; texts_cache.colon = false; texts_cache.front = undefined; texts_cache.back = undefined;
    TrainerCard._onClose = opts.onClose;
    ensureAssets();
    Stack.push("trainer", TrainerCard, { hideBelow: true, fullscreen: true });
    play_se("SE_CARD_OPEN");
  },

  // Lua: trainer_card.lua:645
  close(): void {
    TrainerCard.open = false;
    TrainerCard.side = "front";
    TrainerCard._flip = undefined;
    TrainerCard._session = undefined;
    TrainerCard._card = undefined;
    Stack.pop("trainer");
    const cb = TrainerCard._onClose;
    TrainerCard._onClose = undefined;
    if (cb) cb();
  },

  // Lua: trainer_card.lua:657
  isOpen(): boolean {
    return TrainerCard.open;
  },

  // src/trainer_card.c:550 STATE_HANDLE_INPUT_FRONT / :587 STATE_HANDLE_INPUT_BACK
  // Lua: trainer_card.lua:662
  handleInput(inp?: InputLike): void {
    if (!TrainerCard.open || !inp) return;
    if (TrainerCard._flip) return;
    if (TrainerCard.side === "front") {
      if (inp.wasPressed("a")) {
        beginFlip();
      } else if (inp.wasPressed("b")) {
        TrainerCard.close();
      }
    } else {
      if (inp.wasPressed("b")) {
        beginFlip();
      } else if (inp.wasPressed("a")) {
        TrainerCard.close();
      }
    }
  },

  // src/trainer_card.c:1046 PrintAllOnCardFront
  // Lua: trainer_card.lua:695
  frontTexts(cIn?: any, colonInvisible?: boolean): CardText[] {
    const c = cIn || TrainerCard._card || gather(TrainerCard._session);
    const t: CardText[] = [];
    const add = (id: string, txt: string, x: number, y: number, stat?: boolean): void => {
      t.push({ id, text: txt, x: WIN_X + x, y: WIN_Y + y, stat: stat || false });
    };

    add("name", RomText.plain("gText_TrainerCardName") + c.playerName, 20, 29);
    add("id", RomText.plain("gText_TrainerCardIDNo") + leading_zeros(c.trainerId, 5), 142, 10);

    add("money_label", RomText.plain("gText_TrainerCardMoney"), 20, 56);
    const yen = text("gText_TrainerCardYen");
    const moneyStr = yen ? (yen + tostring(c.money))
      : RomText.plain("gText_PokedollarVar1", { stringVars: seq(tostring(c.money)) });
    add("money", moneyStr, 134 - CHAR_ADVANCE * str_length(moneyStr), 56);

    if (c.hasPokedex) {
      add("dex_label", RomText.plain("gText_TrainerCardPokedex"), 20, 72);
      const dexStr = tostring(c.caughtMonsCount);
      add("dex", dexStr, 136 - CHAR_ADVANCE * str_length(dexStr), 72);
    }

    add("time_label", RomText.plain("gText_TrainerCardTime"), 20, 88);
    add("hours", right_align(c.playTimeHours, 3), 101, 88);
    if (!colonInvisible) {
      add("colon", RomText.plain("gText_Colon2"), 119, 88);
    }
    add("minutes", leading_zeros(c.playTimeMinutes, 2), 124, 88);
    return t;
  },

  // src/trainer_card.c:1076 PrintAllOnCardBack
  // Lua: trainer_card.lua:725
  backTexts(cIn?: any): CardText[] {
    const c = cIn || TrainerCard._card || gather(TrainerCard._session);
    const t: CardText[] = [];
    const add = (id: string, txt: string, x: number, y: number, stat?: boolean): void => {
      t.push({ id, text: txt, x: WIN_X + x, y: WIN_Y + y, stat: stat || false });
    };

    add("name", c.playerName, 138, 11);

    if (c.hasHofResult) {
      add("hof_label", RomText.plain("gText_HallOfFameDebut"), 10, 35);
      add("hof", right_align(c.hofDebutHours, 3)
        + ":" + leading_zeros(c.hofDebutMinutes, 2)
        + ":" + leading_zeros(c.hofDebutSeconds, 2), 164, 35, true);
    }

    if (c.hasLinkResults) {
      add("link_label", RomText.plain("gText_LinkBattles"), 10, 51);
      add("link_w", "W:", 130, 51);
      add("link_wins", right_align(c.linkBattleWins, 4), 144, 51, true);
      add("link_l", "L:", 178, 51);
      add("link_losses", right_align(c.linkBattleLosses, 4), 192, 51, true);
    }

    if (c.hasTrades) {
      add("trades_label", RomText.plain("gText_PokemonTrades"), 10, 67);
      add("trades", right_align(c.pokemonTrades, 5), 186, 67, true);
    }

    if (c.unionRoomNum !== 0) {
      add("union_label", text("gText_UnionRoomTradesBattles", "gText_UnionTradesAndBattles") || "", 10, 83);
      add("union", right_align(c.unionRoomNum, 5), 186, 83, true);
    }

    if (c.berryCrushPoints !== 0) {
      add("berry_label", text("gText_BerryCrushes", "gText_BerryCrush") || "", 10, 99);
      add("berry", right_align(c.berryCrushPoints, 5), 186, 99, true);
    }
    return t;
  },

  // Lua: trainer_card.lua:769
  cardData: gather,

  // pokeemerald/src/trainer_card.c:1003
  // Lua: trainer_card.lua:925
  frontTextsRse(c: any, colonInvisible?: boolean): CardText[] {
    const t: CardText[] = [];
    const add = (txt: string, x: number, y: number, stat?: boolean): void => {
      t.push({ text: txt, x: WIN_X + x, y: WIN_Y + y, stat: stat || false });
    };
    add(RomText.plain("gText_TrainerCardName") + c.playerName, 16, 33);
    const id = RomText.plain("gText_TrainerCardIDNo") + leading_zeros(c.trainerId, 5);
    add(id, Math.floor((96 - FrlgFont.measure(id)) / 2) + 120, 9);
    add(RomText.plain("gText_TrainerCardMoney"), 16, 57);
    const money = RomText.plain("gText_PokedollarVar1", { stringVars: seq(tostring(c.money)) });
    add(money, 128 - FrlgFont.measure(money), 57);
    if (c.hasPokedex) {
      add(RomText.plain("gText_TrainerCardPokedex"), 16, 73);
      const dex = tostring(c.caughtMonsCount);
      add(dex, 128 - FrlgFont.measure(dex), 73);
    }
    add(RomText.plain("gText_TrainerCardTime"), 16, 89);
    // pokeemerald/src/trainer_card.c:1098
    const colonW = FrlgFont.measure(RomText.plain("gText_Colon2"));
    const x = 128 - (colonW + 30);
    const hours = tostring(Math.min(999, c.playTimeHours));
    add(hours, x + 18 - FrlgFont.measure(hours), 89);
    if (!colonInvisible) add(RomText.plain("gText_Colon2"), x + 18, 89);
    add(leading_zeros(c.playTimeMinutes, 2), x + 18 + colonW, 89);
    return t;
  },

  // pokeemerald/src/trainer_card.c:1175
  // Lua: trainer_card.lua:952
  backTextsRse(c: any): CardText[] {
    const t: CardText[] = [];
    const add = (txt: string, x: number, y: number, stat?: boolean): void => {
      t.push({ text: txt, x: WIN_X + x, y: WIN_Y + y, stat: stat || false });
    };
    let title = RomText.plain("gText_Var1sTrainerCard", { stringVars: seq(c.playerName) });
    // pokefirered/src/trainer_card.c:1260
    if (!find(title, c.playerName, 1, true)) title = c.playerName + title;
    add(title, 216 - FrlgFont.measure(title), 9);
    const row = (top: number, labelKey: string, valueIn: string | (() => string), stat?: boolean): void => {
      if (!RomText.has(labelKey)) return;
      const value = typeof valueIn === "function" ? valueIn() : valueIn;
      add(RomText.plain(labelKey), 16, top * 16 + 33);
      add(value, 216 - FrlgFont.measure(value), top * 16 + 33, stat);
    };
    if (c.hasHofResult) {
      row(0, "gText_HallOfFameDebut", format("%d:%02d:%02d", c.hofDebutHours, c.hofDebutMinutes, c.hofDebutSeconds), true);
    }
    if (c.hasLinkResults) {
      const wins = tostring(c.linkBattleWins), losses = tostring(c.linkBattleLosses);
      row(1, "gText_LinkBattles", RomText.has("gText_WinsLosses")
        ? RomText.plain("gText_WinsLosses", { stringVars: seq(wins, losses) })
        : format("W:%4s L:%4s", wins, losses));
    }
    if (c.hasTrades) row(2, "gText_PokemonTrades", tostring(c.pokemonTrades), true);
    if (c.pokeblocksWithFriends !== 0) {
      row(3, "gText_PokeblocksWithFriends", () => {
        return RomText.plain("gText_NumPokeblocks", { stringVars: seq(tostring(c.pokeblocksWithFriends)) });
      }, true);
    }
    if (c.contestsWithFriends !== 0) row(4, "gText_WonContestsWFriends", tostring(c.contestsWithFriends), true);
    if (c.frontierBP !== 0) {
      row(5, "gText_BattlePtsWon", () => {
        return RomText.plain("gText_NumBP", { stringVars: seq(tostring(c.frontierBP)) });
      }, true);
    }
    return t;
  },

  // Lua: trainer_card.lua:1050
  draw(): void {
    if (!TrainerCard.open) return;
    if (TrainerCard._rse) {
      return drawRse(TrainerCard._card || gatherRse(TrainerCard._session));
    }
    ensureAssets();
    const c = TrainerCard._card || gather(TrainerCard._session);

    // src/trainer_card.c:1613 BlinkTimeColon toggles every 61 vblanks
    let colonOn = true;
    if (Timer && Timer.getTime) {
      colonOn = (luaMod(Math.floor(Timer.getTime() * 60 / 61), 2) === 0);
    }
    TrainerCard._colonInvisible = !colonOn;

    const side: string = TrainerCard.side;
    const bg = card_image(side, c.stars, c.female);

    const f: Flip | undefined = TrainerCard._flip;
    if (f) {
      const screen = screen_image(c.stars, c.female);
      G.setColor(1, 1, 1, 1);
      if (screen) {
        G.draw(screen, 0, 0);
      } else {
        const e = _cardEdge[format("%s%d%s", side, c.stars, c.female ? "f" : "m")];
        G.setColor(e ? e[0]! : 0, e ? e[1]! : 0, e ? e[2]! : 0, 1);
        G.rectangle("fill", 0, 0, 240, 160);
        G.setColor(1, 1, 1, 1);
      }
      const scale = Math.max(0, (160 - 2 * f.top) / 160);
      G.push();
      G.translate(0, 80);
      G.scale(1, scale);
      G.translate(0, -80);
    }

    G.setColor(1, 1, 1, 1);
    if (bg) {
      G.draw(bg, 0, 0);
    } else {
      G.setColor(0.85, 0.55, 0.35, 1);
      G.rectangle("fill", 16, 8, 208, 144);
      G.setColor(0.98, 0.92, 0.78, 1);
      G.rectangle("fill", 24, 16, 192, 128);
      G.setColor(1, 1, 1, 1);
    }

    if (side === "back") {
      draw_back(c);
    } else {
      draw_front(c);
    }

    if (f) {
      G.pop();
      // src/trainer_card.c:1000 UpdateCardFlipRegs blendY = (cardTop + 40) / 10
      const blendY = Math.floor((f.top + 40) / 10);
      if (blendY > 4) {
        G.setColor(0, 0, 0, Math.min(1, blendY / 16));
        G.rectangle("fill", 0, 0, 240, 160);
        G.setColor(1, 1, 1, 1);
      }
    }
  },
};

export default TrainerCard;
