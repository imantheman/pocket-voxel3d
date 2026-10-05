// Port of gen1recomp src/ui/game3/frlg_font.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG Latin variable-width font (pret latin_normal + sFontNormalLatinGlyphWidths).
// Field dialogue must use this — Gen2 Font.lua is fixed 8px and overflows the 208px box.
//
// Colours are Lua sequences ({r, g, b, a} -> [null, r, g, b, a]); G.setColor
// is always called with the four values unpacked. Strings are byte strings:
// the glyph tables' UTF-8 characters are built with utf8() from the source
// text below, which yields the same bytes the Lua literals hold.

import { mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type ImageData, type Quad } from "../platform/image.ts";
import { Fs } from "../platform/fs.ts";
import { luaLoad } from "../platform/luadata.ts";
import { gmatch, gsub, match } from "../platform/lpattern.ts";
import { concat, ipairs, len, pairs, seq, type LuaTable } from "../platform/lt.ts";
import { NotPortedError } from "../notported.ts";
import { TextIR, bindFrlgFont } from "../core/scripting/text_ir.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { Profile } from "../core/profile.ts";
import { Runtime } from "../core/runtime.ts";
import { GameVersion } from "../../../import/gen3/game_version.ts";

/** A colour: a Lua sequence {r, g, b, a} (slot 0 unused). */
export type Col = number[];
/** The 3-slot colour table (foreground, shadow, background/highlight). */
export interface Colors { fg: Col | undefined; shadow: Col | undefined; bg: Col | undefined }

export interface Atlas { image: Image; fg: Record<number, Quad>; sh: Record<number, Quad>; src: Record<number, Quad> }
export interface Face {
  name: string; fg: Image; sh: Image | undefined; quads: Record<number, Quad>; widths: LuaTable;
  height: number; pitch: number; letterSpacing: number; atlas: Atlas | undefined;
}
interface Sheet { fg: Image; sh: Image | undefined; quads: Record<number, Quad>; widths?: LuaTable; _romBaked?: boolean; atlas: Atlas | undefined }

export interface FontOpts {
  small?: boolean; font?: string; letterSpacing?: number; maxWidth?: number; limitChars?: number;
  colors?: Colors; color?: Col; shadow?: Col; bg?: Col; gfxId?: unknown; npcColor?: number; linePitch?: number;
  [k: string]: unknown;
}

/** UTF-8 bytes of a source-text string (the Lua literal's bytes). */
function utf8(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out += String.fromCharCode(c);
    else if (c < 0x800) out += String.fromCharCode(0xC0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out += String.fromCharCode(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out += String.fromCharCode(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** s:upper() in Lua's C locale (ASCII only). */
function upper(s: string): string {
  return s.replace(/[a-z]+/g, (m) => m.toUpperCase());
}

function rgba(r: number, g: number, b: number, a: number): Col {
  return seq(r, g, b, a) as Col;
}

/**
 * Lua's `pcall(require, "src.import.CacheFs")` followed by a call into it:
 * while CacheFs is still a stub it stands for a failed require (the call
 * yields nil and Brian's love.filesystem fallback runs). Other errors raise.
 */
function viaCacheFs<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch (e) {
    if (e instanceof NotPortedError) return undefined;
    throw e;
  }
}

const hasOwn = Object.prototype.hasOwnProperty;

// 1:1 Standard Text Palettes from pokefirered/graphics/text_window/stdpal_0.pal
// GBA 15-bit BGR555 -> 8-bit RGB888 / normalized 0.0-1.0
const STDPAL: Col[] = [
  rgba(0, 0, 0, 0), // 0: Transparent / Window Fill
  rgba(255 / 255, 255 / 255, 255 / 255, 1), // 1: WHITE (#FFFFFF)
  rgba(98 / 255, 98 / 255, 98 / 255, 1), // 2: DARK_GRAY (#626262)
  rgba(213 / 255, 213 / 255, 205 / 255, 1), // 3: LIGHT_GRAY (#D5D5CD)
  rgba(230 / 255, 8 / 255, 8 / 255, 1), // 4: RED (#E60808)
  rgba(255 / 255, 189 / 255, 115 / 255, 1), // 5: LIGHT_RED (#FFBD73)
  rgba(32 / 255, 156 / 255, 8 / 255, 1), // 6: GREEN (#209C08)
  rgba(148 / 255, 246 / 255, 148 / 255, 1), // 7: LIGHT_GREEN (#94F694)
  rgba(49 / 255, 82 / 255, 205 / 255, 1), // 8: BLUE (#3152CD)
  rgba(164 / 255, 197 / 255, 246 / 255, 1), // 9: LIGHT_BLUE (#A4C5F6)
  rgba(255 / 255, 255 / 255, 255 / 255, 1), // 10: DYNAMIC_COLOR1
  rgba(213 / 255, 230 / 255, 246 / 255, 1), // 11: DYNAMIC_COLOR2
  rgba(164 / 255, 213 / 255, 230 / 255, 1), // 12: DYNAMIC_COLOR3
  rgba(230 / 255, 246 / 255, 255 / 255, 1), // 13: DYNAMIC_COLOR4
  rgba(115 / 255, 164 / 255, 197 / 255, 1), // 14: DYNAMIC_COLOR5
  rgba(74 / 255, 115 / 255, 164 / 255, 1), // 15: DYNAMIC_COLOR6
];

const COLOR_IDS: Record<string, number> = {
  TRANSPARENT: 0,
  WHITE: 1,
  DARK_GRAY: 2,
  LIGHT_GRAY: 3,
  RED: 4,
  LIGHT_RED: 5,
  GREEN: 6,
  LIGHT_GREEN: 7,
  BLUE: 8,
  LIGHT_BLUE: 9,
};

// 3-Slot Color Architecture (Foreground, Shadow, Background/Highlight)
const COLOR: Record<string, Colors> = {
  // Standard NPC / Field Dialogue
  NORMAL: { fg: STDPAL[2], shadow: STDPAL[3], bg: STDPAL[0] },
  // Pokémon Gender Markers (Two tones: Light foreground + Dark shadow)
  MALE: { fg: STDPAL[9], shadow: STDPAL[8], bg: STDPAL[0] },
  GENDER_MALE: { fg: STDPAL[9], shadow: STDPAL[8], bg: STDPAL[0] },
  FEMALE: { fg: STDPAL[5], shadow: STDPAL[4], bg: STDPAL[0] },
  GENDER_FEMALE: { fg: STDPAL[5], shadow: STDPAL[4], bg: STDPAL[0] },
  // Party Menu Specific Two-Tone Gender Markers (from gPartyMenuBg_Pal 59/60, 75/76)
  PARTY_MALE: {
    fg: rgba(65 / 255, 205 / 255, 255 / 255, 1),
    shadow: rgba(0 / 255, 98 / 255, 148 / 255, 1),
    bg: STDPAL[0],
  },
  PARTY_FEMALE: {
    fg: rgba(255 / 255, 156 / 255, 148 / 255, 1),
    shadow: rgba(156 / 255, 65 / 255, 57 / 255, 1),
    bg: STDPAL[0],
  },
  // NPC Dialogue Text Colors (Dark Blue / Dark Red fg, Light Gray shadow)
  MALE_NPC: { fg: STDPAL[8], shadow: STDPAL[3], bg: STDPAL[0] },
  FEMALE_NPC: { fg: STDPAL[4], shadow: STDPAL[3], bg: STDPAL[0] },
  BLUE: { fg: STDPAL[8], shadow: STDPAL[3], bg: STDPAL[0] },
  RED: { fg: STDPAL[4], shadow: STDPAL[5], bg: STDPAL[0] },
  GREEN: { fg: STDPAL[6], shadow: STDPAL[7], bg: STDPAL[0] },
  // Party slot printers & Battle text (White fg, Dark Gray shadow)
  WHITE: { fg: STDPAL[1], shadow: STDPAL[2], bg: STDPAL[0] },
  LIGHT: { fg: STDPAL[1], shadow: STDPAL[2], bg: STDPAL[0] },
  PARTY: { fg: STDPAL[1], shadow: STDPAL[2], bg: STDPAL[0] },
  STAT: { fg: STDPAL[4], shadow: STDPAL[5], bg: STDPAL[0] },
  DARK_GRAY: { fg: STDPAL[2], shadow: STDPAL[3], bg: STDPAL[0] },
  DARK: { fg: STDPAL[2], shadow: STDPAL[3], bg: STDPAL[0] },
};

// include/constants/vars.h:340
const NPC_TEXT_COLOR = {
  MALE: 0,
  FEMALE: 1,
  MON: 2,
  NEUTRAL: 3,
  DEFAULT: 255,
};

// 152-element sTextColorTable from pokefirered/src/dynamic_placeholder_text_util.c
// Each byte holds 2 nybbles: (low_nybble | (high_nybble << 4))
const sTextColorTable: number[] = [
  0x00, // 0 OBJ_EVENT_GFX_RED_NORMAL / OBJ_EVENT_GFX_RED_BIKE
  0x00, // 1 OBJ_EVENT_GFX_RED_SURF / OBJ_EVENT_GFX_RED_FIELD_MOVE
  0x00, // 2 OBJ_EVENT_GFX_RED_FISH / OBJ_EVENT_GFX_RED_VS_SEEKER
  0x10, // 3 OBJ_EVENT_GFX_RED_VS_SEEKER_BIKE / OBJ_EVENT_GFX_GREEN_NORMAL
  0x11, // 4 OBJ_EVENT_GFX_GREEN_BIKE / OBJ_EVENT_GFX_GREEN_SURF
  0x11, // 5 OBJ_EVENT_GFX_GREEN_FIELD_MOVE / OBJ_EVENT_GFX_GREEN_FISH
  0x11, // 6 OBJ_EVENT_GFX_GREEN_VS_SEEKER / OBJ_EVENT_GFX_GREEN_VS_SEEKER_BIKE
  0x10, // 7 OBJ_EVENT_GFX_RS_BRENDAN / OBJ_EVENT_GFX_RS_MAY
  0x10, // 8 OBJ_EVENT_GFX_LITTLE_BOY / OBJ_EVENT_GFX_LITTLE_GIRL
  0x00, // 9 OBJ_EVENT_GFX_YOUNGSTER / OBJ_EVENT_GFX_BOY
  0x00, // 10 OBJ_EVENT_GFX_BUG_CATCHER / OBJ_EVENT_GFX_SITTING_BOY
  0x11, // 11 OBJ_EVENT_GFX_LASS / OBJ_EVENT_GFX_WOMAN_1
  0x01, // 12 OBJ_EVENT_GFX_CRUSH_GIRL / OBJ_EVENT_GFX_MAN
  0x00, // 13 OBJ_EVENT_GFX_ROCKER / OBJ_EVENT_GFX_FAT_MAN
  0x11, // 14 OBJ_EVENT_GFX_WOMAN_2 / OBJ_EVENT_GFX_BEAUTY
  0x10, // 15 OBJ_EVENT_GFX_BALDING_MAN / OBJ_EVENT_GFX_WOMAN_3
  0x00, // 16 OBJ_EVENT_GFX_OLD_MAN_1 / OBJ_EVENT_GFX_OLD_MAN_2
  0x10, // 17 OBJ_EVENT_GFX_OLD_MAN_LYING_DOWN / OBJ_EVENT_GFX_OLD_WOMAN
  0x10, // 18 OBJ_EVENT_GFX_TUBER_M_WATER / OBJ_EVENT_GFX_TUBER_F
  0x00, // 19 OBJ_EVENT_GFX_TUBER_M_LAND / OBJ_EVENT_GFX_CAMPER
  0x01, // 20 OBJ_EVENT_GFX_PICNICKER / OBJ_EVENT_GFX_COOLTRAINER_M
  0x01, // 21 OBJ_EVENT_GFX_COOLTRAINER_F / OBJ_EVENT_GFX_SWIMMER_M_WATER
  0x01, // 22 OBJ_EVENT_GFX_SWIMMER_F_WATER / OBJ_EVENT_GFX_SWIMMER_M_LAND
  0x01, // 23 OBJ_EVENT_GFX_SWIMMER_F_LAND / OBJ_EVENT_GFX_WORKER_M
  0x01, // 24 OBJ_EVENT_GFX_WORKER_F / OBJ_EVENT_GFX_ROCKET_M
  0x01, // 25 OBJ_EVENT_GFX_ROCKET_F / OBJ_EVENT_GFX_GBA_KID
  0x00, // 26 OBJ_EVENT_GFX_POKE_MANIAC / OBJ_EVENT_GFX_BIKER
  0x00, // 27 OBJ_EVENT_GFX_BLACK_BELT / OBJ_EVENT_GFX_SCIENTIST
  0x00, // 28 OBJ_EVENT_GFX_HIKER / OBJ_EVENT_GFX_FISHER
  0x01, // 29 OBJ_EVENT_GFX_CHANNELER / OBJ_EVENT_GFX_CHEF
  0x00, // 30 OBJ_EVENT_GFX_POLICEMAN / OBJ_EVENT_GFX_GENTLEMAN
  0x00, // 31 OBJ_EVENT_GFX_SAILOR / OBJ_EVENT_GFX_CAPTAIN
  0x11, // 32 OBJ_EVENT_GFX_NURSE / OBJ_EVENT_GFX_CABLE_CLUB_RECEPTIONIST
  0x01, // 33 OBJ_EVENT_GFX_UNION_ROOM_RECEPTIONIST / OBJ_EVENT_GFX_UNUSED_MALE_RECEPTIONIST
  0x00, // 34 OBJ_EVENT_GFX_CLERK / OBJ_EVENT_GFX_MG_DELIVERYMAN
  0x00, // 35 OBJ_EVENT_GFX_TRAINER_TOWER_DUDE / OBJ_EVENT_GFX_PROF_OAK
  0x00, // 36 OBJ_EVENT_GFX_BLUE / OBJ_EVENT_GFX_BILL
  0x10, // 37 OBJ_EVENT_GFX_LANCE / OBJ_EVENT_GFX_AGATHA
  0x11, // 38 OBJ_EVENT_GFX_DAISY / OBJ_EVENT_GFX_LORELEI
  0x00, // 39 OBJ_EVENT_GFX_MR_FUJI / OBJ_EVENT_GFX_BRUNO
  0x10, // 40 OBJ_EVENT_GFX_BROCK / OBJ_EVENT_GFX_MISTY
  0x10, // 41 OBJ_EVENT_GFX_LT_SURGE / OBJ_EVENT_GFX_ERIKA
  0x10, // 42 OBJ_EVENT_GFX_KOGA / OBJ_EVENT_GFX_SABRINA
  0x00, // 43 OBJ_EVENT_GFX_BLAINE / OBJ_EVENT_GFX_GIOVANNI
  0x01, // 44 OBJ_EVENT_GFX_MOM / OBJ_EVENT_GFX_CELIO
  0x00, // 45 OBJ_EVENT_GFX_TEACHY_TV_HOST / OBJ_EVENT_GFX_GYM_GUY
  0x33, // 46 OBJ_EVENT_GFX_ITEM_BALL / OBJ_EVENT_GFX_TOWN_MAP
  0x33, // 47 OBJ_EVENT_GFX_POKEDEX / OBJ_EVENT_GFX_CUT_TREE
  0x33, // 48 OBJ_EVENT_GFX_ROCK_SMASH_ROCK / OBJ_EVENT_GFX_PUSHABLE_BOULDER
  0x33, // 49 OBJ_EVENT_GFX_FOSSIL / OBJ_EVENT_GFX_RUBY
  0x33, // 50 OBJ_EVENT_GFX_SAPPHIRE / OBJ_EVENT_GFX_OLD_AMBER
  0x33, // 51 OBJ_EVENT_GFX_GYM_SIGN / OBJ_EVENT_GFX_SIGN
  0x33, // 52 OBJ_EVENT_GFX_TRAINER_TIPS / OBJ_EVENT_GFX_CLIPBOARD
  0x33, // 53 OBJ_EVENT_GFX_METEORITE / OBJ_EVENT_GFX_LAPRAS_DOLL
  0x23, // 54 OBJ_EVENT_GFX_SEAGALLOP / OBJ_EVENT_GFX_SNORLAX
  0x22, // 55 OBJ_EVENT_GFX_SPEAROW / OBJ_EVENT_GFX_CUBONE
  0x22, // 56 OBJ_EVENT_GFX_POLIWRATH / OBJ_EVENT_GFX_CLEFAIRY
  0x22, // 57 OBJ_EVENT_GFX_PIDGEOT / OBJ_EVENT_GFX_JIGGLYPUFF
  0x22, // 58 OBJ_EVENT_GFX_PIDGEY / OBJ_EVENT_GFX_CHANSEY
  0x22, // 59 OBJ_EVENT_GFX_OMANYTE / OBJ_EVENT_GFX_KANGASKHAN
  0x22, // 60 OBJ_EVENT_GFX_PIKACHU / OBJ_EVENT_GFX_PSYDUCK
  0x22, // 61 OBJ_EVENT_GFX_NIDORAN_F / OBJ_EVENT_GFX_NIDORAN_M
  0x22, // 62 OBJ_EVENT_GFX_NIDORINO / OBJ_EVENT_GFX_MEOWTH
  0x22, // 63 OBJ_EVENT_GFX_SEEL / OBJ_EVENT_GFX_VOLTORB
  0x22, // 64 OBJ_EVENT_GFX_SLOWPOKE / OBJ_EVENT_GFX_SLOWBRO
  0x22, // 65 OBJ_EVENT_GFX_MACHOP / OBJ_EVENT_GFX_WIGGLYTUFF
  0x22, // 66 OBJ_EVENT_GFX_DODUO / OBJ_EVENT_GFX_FEAROW
  0x22, // 67 OBJ_EVENT_GFX_MACHOKE / OBJ_EVENT_GFX_LAPRAS
  0x22, // 68 OBJ_EVENT_GFX_ZAPDOS / OBJ_EVENT_GFX_MOLTRES
  0x22, // 69 OBJ_EVENT_GFX_ARTICUNO / OBJ_EVENT_GFX_MEWTWO
  0x22, // 70 OBJ_EVENT_GFX_MEW / OBJ_EVENT_GFX_ENTEI
  0x22, // 71 OBJ_EVENT_GFX_SUICUNE / OBJ_EVENT_GFX_RAIKOU
  0x22, // 72 OBJ_EVENT_GFX_LUGIA / OBJ_EVENT_GFX_HO_OH
  0x22, // 73 OBJ_EVENT_GFX_CELEBI / OBJ_EVENT_GFX_KABUTO
  0x22, // 74 OBJ_EVENT_GFX_DEOXYS_D / OBJ_EVENT_GFX_DEOXYS_A
  0x32, // 75 OBJ_EVENT_GFX_DEOXYS_N / OBJ_EVENT_GFX_SS_ANNE
];

// pret DecompressGlyph_Small: height 13; widths ~4–8 (party nick/HP).
const SMALL_GLYPH_HEIGHT = 13;
const SMALL_LINE_PITCH = 14;

interface PathItem { path: string; w: number; h: number }

const FG_PATHS: PathItem[] = [
  { path: "chrome/fonts/latin_normal_fg.rgba", w: 256, h: 512 },
  { path: "data/generated/gba/chrome/fonts/latin_normal_fg.rgba", w: 256, h: 512 },
];
const SH_PATHS: PathItem[] = [
  { path: "chrome/fonts/latin_normal_shadow.rgba", w: 256, h: 512 },
  { path: "data/generated/gba/chrome/fonts/latin_normal_shadow.rgba", w: 256, h: 512 },
];
const SMALL_FG_PATHS: PathItem[] = [
  { path: "chrome/fonts/latin_small_fg.rgba", w: 256, h: 512 },
  { path: "data/generated/gba/chrome/fonts/latin_small_fg.rgba", w: 256, h: 512 },
];
const SMALL_SH_PATHS: PathItem[] = [
  { path: "chrome/fonts/latin_small_shadow.rgba", w: 256, h: 512 },
  { path: "data/generated/gba/chrome/fonts/latin_small_shadow.rgba", w: 256, h: 512 },
];

// Lua: frlg_font.lua:229
function log(msg: unknown): void {
  // print -> Logger once shared/core/Logger is ported
  console.log("[game3/frlg_font] " + tostring(msg));
}

// Lua: frlg_font.lua:233
function loadImage(candidates: (PathItem | string)[]): [Image | undefined, string | undefined, ImageData | undefined] {
  for (const item of candidates) {
    const path = typeof item === "object" ? item.path : item;
    const w = typeof item === "object" ? item.w : 256;
    const h = typeof item === "object" ? item.h : 512;
    let data: string | undefined = undefined;
    data = viaCacheFs(() => CacheFs.readActive(path) as string | undefined) ?? undefined;
    if (!truthy(data)) data = viaCacheFs(() => CacheFs.read(path) as string | undefined) ?? undefined;
    if (!truthy(data)) {
      data = Fs.read(path);
      if (!truthy(data)) {
        data = Fs.read("data/generated/gba/" + gsub(path, "^data/generated/gba/", "")[0]);
      }
    }
    // NOT FAITHFUL: the io.open fallback (a file beside the executable) has no 3DS equivalent
    if (data !== undefined && typeof data === "string" && data.length > 0) {
      if (data.length === w * h * 4) {
        let id: ImageData | undefined;
        try { id = newImageData(w, h, "rgba8", data); } catch { id = undefined; }
        if (id) {
          const img = G.newImage(id);
          if (img && img.setFilter) img.setFilter("nearest", "nearest");
          return [img, path, id];
        }
      } else {
        let fd;
        try { fd = Fs.newFileData(data, path); } catch { fd = undefined; }
        if (fd) {
          let id: ImageData | undefined;
          try { id = newImageData(fd); } catch { id = undefined; }
          if (id) {
            const img = G.newImage(id);
            if (img && img.setFilter) img.setFilter("nearest", "nearest");
            return [img, path, id];
          }
        }
      }
    }
    if (Fs.getInfo(path)) {
      let img: Image | undefined;
      try { img = G.newImage(path); } catch { img = undefined; }
      if (img) {
        if (img.setFilter) img.setFilter("nearest", "nearest");
        return [img, path, undefined];
      }
    }
  }
  return [undefined, undefined, undefined];
}

// Pack a sheet's fg and shadow images into one texture (fg on top, shadow
// below a transparent gap) with matching quads.  Each glyph still draws its
// shadow then its fg, but from the same texture, so LOVE's autobatcher keeps
// a whole string in one draw call instead of flushing on every texture swap.
// Pixels are copied verbatim, so the output is unchanged.  nil (draw from the
// separate sheets) when either ImageData is missing or they do not match.
const ATLAS_GAP = 16;
// Lua: frlg_font.lua:299
function pack_atlas(fgData: ImageData | undefined, shData: ImageData | undefined, quads: Record<number, Quad> | undefined): Atlas | undefined {
  if (!(fgData && shData && quads)) return undefined;
  try {
    const [w, h] = fgData.getDimensions();
    const [sw, shh] = shData.getDimensions();
    if (sw !== w || shh !== h) return undefined;
    if (fgData.getFormat() !== shData.getFormat()) return undefined;
    const off = h + ATLAS_GAP;
    const fmt = fgData.getFormat();
    const data = newImageData(w, off + h, fmt);
    data.paste(fgData, 0, 0, 0, 0, w, h);
    data.paste(shData, 0, off, 0, 0, w, h);
    const img = G.newImage(data);
    img.setFilter("nearest", "nearest");
    const [aw, ah] = img.getDimensions();
    const fq: Record<number, Quad> = {}, sq: Record<number, Quad> = {};
    for (const [id, q] of pairs<Quad>(quads)) {
      const [qx, qy, qw, qh] = q.getViewport();
      fq[id as number] = G.newQuad(qx, qy, qw, qh, aw, ah);
      sq[id as number] = G.newQuad(qx, qy + off, qw, qh, aw, ah);
    }
    return { image: img, fg: fq, sh: sq, src: quads };
  } catch {
    return undefined;
  }
}

// Lua: frlg_font.lua:328
function loadTable(path: string): LuaTable | undefined {
  const src = viaCacheFs(() => CacheFs.readActive(path));
  if (typeof src !== "string") return undefined;
  const [chunk] = luaLoad(src, "@" + path);
  if (!chunk) return undefined;
  let t: unknown;
  try { t = chunk(); } catch { return undefined; }
  return t !== null && typeof t === "object" ? t : undefined;
}

// Lua: frlg_font.lua:344
function applyPalette(spec: LuaTable | undefined): void {
  let pal = spec && spec.palette ? loadTable(spec.palette.file) : undefined;
  pal = pal ? pal[spec.palette.key] : undefined;
  if (pal !== null && typeof pal === "object") {
    if (!FrlgFont._stdpalSaved) {
      FrlgFont._stdpalSaved = [];
      for (let i = 1; i <= 15; i++) {
        const c = STDPAL[i]!;
        FrlgFont._stdpalSaved[i] = rgba(c[1]!, c[2]!, c[3]!, c[4]!);
      }
    }
    for (let i = 1; i <= 15; i++) {
      const rgb = pal[i], c = STDPAL[i]!;
      if (rgb !== null && typeof rgb === "object") {
        c[1] = rgb[1] / 255; c[2] = rgb[2] / 255; c[3] = rgb[3] / 255; c[4] = 1;
      }
    }
  } else if (FrlgFont._stdpalSaved) {
    for (let i = 1; i <= 15; i++) {
      const s = FrlgFont._stdpalSaved[i]!, c = STDPAL[i]!;
      c[1] = s[1]!; c[2] = s[2]!; c[3] = s[3]!; c[4] = s[4]!;
    }
    FrlgFont._stdpalSaved = undefined;
  }
}

// Lua: frlg_font.lua:370
function resolveSpec(): [LuaTable | undefined, string | undefined] {
  let row: unknown;
  let ok: boolean;
  try { row = Profile.forSession(); ok = true; } catch { ok = false; }
  const font = ok && row !== null && typeof row === "object" ? (row as LuaTable).font : undefined;
  if (font !== null && typeof font === "object" && font.faces !== null && typeof font.faces === "object") {
    return [font, (row as LuaTable).id];
  }
  return [undefined, undefined];
}

// Lua: frlg_font.lua:383
function sync(): LuaTable | undefined {
  // package.loaded["src.core.game3.runtime"] / ["src.core.GameVersion"]
  const session = Runtime ? Runtime.session : undefined;
  const GV = GameVersion;
  const v = (session !== null && typeof session === "object" && truthy(session.version) ? session.version : undefined)
    ?? (GV && truthy(GV.current) ? GV.current : undefined) ?? "";
  if (v === FrlgFont._syncVersion) return FrlgFont._spec;
  FrlgFont._syncVersion = v;
  const [spec, id] = resolveSpec();
  const key = spec ? id : "frlg";
  if (FrlgFont._specKey !== key) {
    if (FrlgFont._specKey !== undefined) FrlgFont.invalidate();
    FrlgFont._specKey = key;
    applyPalette(spec);
  }
  FrlgFont._spec = spec;
  return spec;
}

// Lua: frlg_font.lua:403
function metricsFor(spec: LuaTable, fontId: unknown): LuaTable | undefined {
  if (FrlgFont._metrics === undefined) {
    FrlgFont._metrics = (spec.metrics ? loadTable(spec.metrics) : undefined) ?? false;
  }
  for (const [, m] of pairs(FrlgFont._metrics || {})) {
    if (m !== null && typeof m === "object" && m.name === fontId) return m;
  }
  return undefined;
}

// Lua: frlg_font.lua:413
function faceName(opts: FontOpts | undefined): string {
  return (opts && opts.font) || (opts && opts.small ? "small" : undefined) || "normal";
}

// Lua: frlg_font.lua:417
function loadFace(spec: LuaTable, name: string): Face | undefined {
  const cached = FrlgFont._faces[name];
  if (cached !== undefined) return cached || undefined;
  if (spec.palette && !FrlgFont._stdpalSaved) applyPalette(spec);
  const fs = spec.faces[name];
  if (fs === null || typeof fs !== "object") {
    throw new Error("FrlgFont: the active profile has no font face '" + tostring(name) + "'");
  }
  const dir = spec.dir || "";
  const [fg, fgp, fgData] = loadImage([{ path: dir + fs.sheet + "_fg.rgba", w: 256, h: 512 }]);
  const [sh, , shData] = loadImage([{ path: dir + fs.sheet + "_shadow.rgba", w: 256, h: 512 }]);
  const widths = fs.widths ? loadTable(dir + fs.widths) : undefined;
  const m = metricsFor(spec, fs.fontId);
  if (!(fg && widths && m)) {
    log(fs.sheet + " missing from the cache");
    FrlgFont._faces[name] = false;
    return undefined;
  }
  const [iw, ih] = fg.getDimensions();
  const quads: Record<number, Quad> = {};
  for (let id = 0; id <= 511; id++) {
    let gw = tonumber(widths[id] ?? widths[0]) ?? 16;
    if (gw <= 0 || gw > 16) gw = 16;
    // pokeemerald/src/text.c:608
    quads[id] = G.newQuad((id % 16) * 16, Math.floor(id / 16) * 16, gw, 16, iw, ih);
  }
  const face: Face = {
    name, fg, sh, quads, widths,
    height: m.maxLetterHeight, pitch: m.maxLetterHeight + (m.lineSpacing ?? 0),
    letterSpacing: m.letterSpacing ?? 0,
    atlas: pack_atlas(fgData, shData, quads),
  };
  FrlgFont._faces[name] = face;
  log(fs.sheet + " ready " + tostring(fgp));
  return face;
}

// Lua: frlg_font.lua:454
function faceFor(opts?: FontOpts): Face | undefined {
  const spec = sync();
  if (!spec) return undefined;
  return loadFace(spec, faceName(opts));
}

// Lua: frlg_font.lua:462
function faceAdvance(face: Face, glyphId: number): number {
  let w = face.widths[glyphId];
  if (w == null) w = face.widths[0] ?? 0;
  return w;
}

/** Read a cache Lua file: CacheFs.readActive, then CacheFs.read, then love.filesystem (Brian's order). */
function readWidthsSource(path: string, alt: string): string | undefined {
  let src = viaCacheFs(() => CacheFs.readActive(path) as string | undefined) ?? undefined;
  if (!truthy(src)) src = viaCacheFs(() => CacheFs.read(path) as string | undefined) ?? undefined;
  if (!truthy(src)) src = Fs.read(path) ?? Fs.read(alt);
  return src;
}

// Lua: frlg_font.lua:474
function ensure(): boolean {
  if (FrlgFont._fg && FrlgFont._widths && FrlgFont._quads) {
    return true;
  }
  let widths = FrlgFont._widths;
  if (!widths) {
    const src = readWidthsSource("data/generated/gba/chrome/fonts/latin_widths.lua", "chrome/fonts/latin_widths.lua");
    if (src && typeof src === "string") {
      const [chunk] = luaLoad(src, "@latin_widths.lua");
      if (chunk) widths = chunk();
    }
  }
  // NOT FAITHFUL: the require("src.import.gba.chrome.fonts.latin_widths") /
  // sevii/ loadfile fallbacks read Lua files shipped beside the game; the 3DS
  // has only the cache
  FrlgFont._widths = widths || {};

  const [fg, fgp, fgData] = loadImage(FG_PATHS);
  const [sh, , shData] = loadImage(SH_PATHS);
  if (!fg) {
    if (!FrlgFont._logged) {
      log("latin_normal font missing");
      FrlgFont._logged = true;
    }
    return false;
  }
  FrlgFont._fg = fg;
  FrlgFont._sh = sh;
  const [iw, ih] = fg.getDimensions();
  const quads: Record<number, Quad> = {};
  for (let id = 0; id <= 511; id++) {
    const col = id % 16;
    const row = Math.floor(id / 16);
    quads[id] = G.newQuad(col * 16, row * 16, 16, 16, iw, ih);
  }
  FrlgFont._quads = quads;
  FrlgFont._atlas = pack_atlas(fgData, shData, quads);
  if (!FrlgFont._logged) {
    log("latin_normal ready " + tostring(fgp));
    FrlgFont._logged = true;
  }
  return true;
}

// Lua: frlg_font.lua:538
function ensure_small(): boolean {
  if (FrlgFont._small && FrlgFont._small.fg && FrlgFont._small.quads) {
    return true;
  }
  let widths: LuaTable | undefined;
  const src = readWidthsSource("data/generated/gba/chrome/fonts/latin_small_widths.lua", "chrome/fonts/latin_small_widths.lua");
  if (src && typeof src === "string") {
    const [chunk] = luaLoad(src, "@latin_small_widths.lua");
    if (chunk) widths = chunk();
  }
  // NOT FAITHFUL: the require / sevii loadfile fallbacks (files beside the game) are dropped
  const [fg, fgp, fgData] = loadImage(SMALL_FG_PATHS);
  const [sh, , shData] = loadImage(SMALL_SH_PATHS);
  if (!fg) return false;
  const [iw, ih] = fg.getDimensions();
  const quads: Record<number, Quad> = {};
  const maxId = Math.floor(iw / 16) * Math.floor(ih / 16) - 1;
  for (let id = 0; id <= Math.max(255, maxId); id++) {
    const col = id % 16;
    const row = Math.floor(id / 16);
    if (row * 16 + 16 <= ih) {
      quads[id] = G.newQuad(col * 16, row * 16, 16, 16, iw, ih);
    }
  }
  // Sheets from extract_latin_small.py (ROM hwlat @ 0x1EAF00), CHARMAP-ordered.
  FrlgFont._small = {
    fg, sh, quads, widths: widths || {}, _romBaked: true,
    atlas: pack_atlas(fgData, shData, quads),
  };
  log("latin_small ready " + tostring(fgp) + " (ROM FONT_SMALL)");
  return true;
}

// The US cart's Japanese fonts (pokefirered/src/text.c:141, :227), which the
// text printer draws for a string in Japanese mode.  Their glyphs are numbered
// like the Latin ones, so a Japanese character's id is its byte in the
// Japanese block of pokefirered/charmap.txt, offset by JAPANESE_BASE so it
// never collides with a Latin glyph.  Only characters with no Latin glyph take
// them: kana, and the full-width digits, letters and punctuation Japanese text
// is written with.
const JAPANESE_BASE = 0x400;

const JP_FG_PATHS: PathItem[] = [
  { path: "chrome/fonts/japanese_normal_fg.rgba", w: 256, h: 512 },
  { path: "data/generated/gba/chrome/fonts/japanese_normal_fg.rgba", w: 256, h: 512 },
];
const JP_SH_PATHS: PathItem[] = [
  { path: "chrome/fonts/japanese_normal_shadow.rgba", w: 256, h: 512 },
  { path: "data/generated/gba/chrome/fonts/japanese_normal_shadow.rgba", w: 256, h: 512 },
];
const JP_SMALL_FG_PATHS: PathItem[] = [
  { path: "chrome/fonts/japanese_small_fg.rgba", w: 256, h: 512 },
  { path: "data/generated/gba/chrome/fonts/japanese_small_fg.rgba", w: 256, h: 512 },
];
const JP_SMALL_SH_PATHS: PathItem[] = [
  { path: "chrome/fonts/japanese_small_shadow.rgba", w: 256, h: 512 },
  { path: "data/generated/gba/chrome/fonts/japanese_small_shadow.rgba", w: 256, h: 512 },
];

// pokefirered/charmap.txt: hiragana 01-50, katakana 51-A0, "　" 00, ！？。ー AB-AE,
// ‥ B0.  The font continues with the same symbols as the Latin block at the
// same codes (digits A1-AA, 『』「」 B1-B4, ♂♀ B5-B6, 円 B7, letters BB-EE, ▶ EF,
// ： F0), which Japanese text writes in their full-width forms.
const HIRAGANA = utf8("あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんぁぃぅぇぉゃゅょがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽっ");
const KATAKANA = utf8("アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンァィゥェォャュョガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポッ");
// Lua: frlg_font.lua:624
function japanese_glyphs(): Record<string, number> {
  const t: Record<string, number> = Object.create(null);
  let code = 0x01;
  for (const [ch] of gmatch(HIRAGANA + KATAKANA, "[\xE0-\xEF][\x80-\xBF][\x80-\xBF]")) {
    t[ch as string] = code;
    code = code + 1;
  }
  // Lua: frlg_font.lua:631
  const run = (first: number, from: string, n: number): void => {
    const b1 = from.charCodeAt(0), b2 = from.charCodeAt(1), b3 = from.charCodeAt(2);
    const cp = (b1 % 16) * 4096 + (b2 % 64) * 64 + (b3 % 64);
    for (let i = 0; i <= n - 1; i++) {
      const c = cp + i;
      t[String.fromCharCode(0xE0 + Math.floor(c / 4096), 0x80 + Math.floor(c / 64) % 64, 0x80 + c % 64)] = first + i;
    }
  };
  run(0xA1, utf8("０"), 10);
  run(0xBB, utf8("Ａ"), 26);
  run(0xD5, utf8("ａ"), 26);
  const more: [string, number][] = [
    ["　", 0x00], ["！", 0xAB], ["？", 0xAC], ["。", 0xAD], ["ー", 0xAE], ["・", 0xAF],
    ["‥", 0xB0], ["…", 0xB0], ["『", 0xB1], ["』", 0xB2], ["「", 0xB3], ["」", 0xB4],
    ["円", 0xB7], ["．", 0xB8], ["／", 0xBA], ["：", 0xF0],
  ];
  for (const [ch, c] of more) t[utf8(ch)] = c;
  return t;
}

// Lua: frlg_font.lua:652
function load_japanese(key: "_jpNormal" | "_jpSmall", fgPaths: PathItem[], shPaths: PathItem[]): Sheet | undefined {
  const cur = FrlgFont[key];
  if (cur !== undefined) return cur || undefined;
  const [fg, , fgData] = loadImage(fgPaths);
  if (!fg) {
    FrlgFont[key] = false;
    return undefined;
  }
  const [sh, , shData] = loadImage(shPaths);
  const [iw, ih] = fg.getDimensions();
  const quads: Record<number, Quad> = {};
  for (let code = 0; code <= 511; code++) {
    quads[code] = G.newQuad((code % 16) * 16, Math.floor(code / 16) * 16, 16, 16, iw, ih);
  }
  const sheet: Sheet = { fg, sh, quads, atlas: pack_atlas(fgData, shData, quads) };
  FrlgFont[key] = sheet;
  return sheet;
}

// Lua: frlg_font.lua:669
function japanese_widths(): LuaTable {
  if (FrlgFont._jpWidths) return FrlgFont._jpWidths;
  let widths: LuaTable | undefined;
  const path = "data/generated/gba/chrome/fonts/japanese_widths.lua";
  let src = viaCacheFs(() => CacheFs.readActive(path) as string | undefined) ?? undefined;
  if (!truthy(src)) src = viaCacheFs(() => CacheFs.read(path) as string | undefined) ?? undefined;
  if (!truthy(src)) {
    src = Fs.read(path) ?? Fs.read("chrome/fonts/japanese_widths.lua");
  }
  if (typeof src === "string") {
    const [chunk] = luaLoad(src, "@japanese_widths.lua");
    if (chunk) widths = chunk();
  }
  FrlgFont._jpWidths = widths || {};
  return FrlgFont._jpWidths;
}

// The Japanese sheet (small or normal) and the quad for a Japanese glyph id.
// Lua: frlg_font.lua:687
function japanese_quad(glyphId: number, small: boolean): [Image | undefined, Image | undefined, Quad | undefined, Atlas | undefined] {
  const sheet = (small ? load_japanese("_jpSmall", JP_SMALL_FG_PATHS, JP_SMALL_SH_PATHS) : undefined)
    || load_japanese("_jpNormal", JP_FG_PATHS, JP_SH_PATHS);
  if (!sheet) return [undefined, undefined, undefined, undefined];
  return [sheet.fg, sheet.sh, sheet.quads[glyphId - JAPANESE_BASE], sheet.atlas];
}

// The remaining single characters of the Latin block of pret
// pokefirered/charmap.txt: glyphs the US ROM font draws (latin_normal and
// latin_small, both charmap-ordered) that US text never prints, so
// TextIR.CHARMAP (the decode table) leaves them out.  Named multi-glyph
// entries (LV, POKEBLOCK, the SUPER_E/ER/RE superscripts) are not characters
// and stay out.
// Mod text in French, German, Spanish or Italian needs them; without an entry
// glyphId falls back to 0x00 and the letter prints blank.  Render-only: the
// ROM decode path is unchanged.
const LATIN_GLYPHS: Record<number, string> = {};
for (const [code, ch] of [
  [0x01, "À"], [0x02, "Á"], [0x03, "Â"], [0x04, "Ç"], [0x05, "È"],
  [0x07, "Ê"], [0x08, "Ë"], [0x09, "Ì"], [0x0B, "Î"], [0x0C, "Ï"],
  [0x0D, "Ò"], [0x0E, "Ó"], [0x0F, "Ô"], [0x10, "Œ"], [0x11, "Ù"],
  [0x12, "Ú"], [0x13, "Û"], [0x14, "Ñ"], [0x15, "ß"], [0x16, "à"],
  [0x17, "á"], [0x19, "ç"], [0x1A, "è"], [0x1C, "ê"], [0x1D, "ë"],
  [0x1E, "ì"], [0x20, "î"], [0x21, "ï"], [0x22, "ò"], [0x23, "ó"],
  [0x24, "ô"], [0x25, "œ"], [0x26, "ù"], [0x27, "ú"], [0x28, "û"],
  [0x29, "ñ"], [0x2A, "º"], [0x2B, "ª"], [0x36, ";"], [0x51, "¿"],
  [0x52, "¡"], [0x5A, "Í"], [0x68, "â"], [0x6F, "í"],
  [0xEF, "▶"], [0xF1, "Ä"], [0xF2, "Ö"], [0xF3, "Ü"], [0xF4, "ä"],
  [0xF5, "ö"], [0xF6, "ü"],
] as [number, string][]) LATIN_GLYPHS[code] = utf8(ch);

// Lua: frlg_font.lua:717
function buildRev(): Record<string, number> {
  if (FrlgFont._rev) return FrlgFont._rev;
  const rev: Record<string, number> = Object.create(null);
  for (const [ch, code] of [
    [" ", 0x00],
    ["\n", 0xFE],
    ["№", 0x108],
    ["↑", 0x100], ["↓", 0x101], ["←", 0x102], ["→", 0x103],
    ["①", 0x10A], ["②", 0x10B], ["③", 0x10C],
    ["④", 0x10D], ["⑤", 0x10E], ["⑥", 0x10F],
    ["⑦", 0x110], ["⑧", 0x111], ["⑨", 0x112],
    ["◎", 0x115], ["△", 0x116], ["✕", 0x117],
    ["No", 0x108],
    ["▶", 0xEF], // gText_SelectorArrow2 / CHAR_SELECTOR_ARROW
    ["▲", 0x79], // CHAR_UP_ARROW
    ["▼", 0x7A], // CHAR_DOWN_ARROW
    ["◀", 0x7B], // CHAR_LEFT_ARROW
    ["_", 0x109], // CHAR_EXTRA_SYMBOL + CHAR_UNDERSCORE
    ['"', 0xB2],
    ["“", 0xB1],
    ["”", 0xB2],
    ["‘", 0xB3],
    ["’", 0xB4],
    ["'", 0xB4],
    ["$", 0xB7],
    ["¥", 0xB7],
  ] as [string, number][]) rev[utf8(ch)] = code;
  rev["\xC2\xA5"] = 0xB7;
  for (const [code, ch] of pairs<string>(TextIR.CHARMAP || {})) {
    if (typeof ch === "string" && ch.length > 0 && rev[ch] == null) {
      rev[ch] = code as number;
    }
  }
  for (const [code, ch] of pairs<string>(LATIN_GLYPHS)) {
    if (rev[ch] == null) rev[ch] = code as number;
  }
  for (const [ch, code] of pairs<number>(FrlgFont.JAPANESE_GLYPHS)) {
    if (rev[ch as string] == null) rev[ch as string] = JAPANESE_BASE + code;
  }
  // ASCII digits/letters already via CHARMAP; ensure common punctuation.
  FrlgFont._rev = rev;
  return rev;
}

/** UTF-8 iterate: yield [char, byteFrom, byteTo] (1-based). */
// Lua: frlg_font.lua:761
function utf8Chars(s: string): () => [string, number, number] | undefined {
  let i = 1;
  const n = s.length;
  return () => {
    if (i > n) return undefined;
    const b = s.charCodeAt(i - 1);
    let l = 1;
    if (b >= 0xF0) l = 4;
    else if (b >= 0xE0) l = 3;
    else if (b >= 0xC0) l = 2;
    if (i + l - 1 > n) l = 1;
    const ch = s.substring(i - 1, i - 1 + l);
    const from = i;
    i = i + l;
    return [ch, from, i - 1];
  };
}

// charmap.txt:42-66
const GLYPH_TAGS: Record<string, number[]> = {
  PK: seq(0x53) as number[],
  MN: seq(0x54) as number[],
  PKMN: seq(0x53, 0x54) as number[],
  POKEBLOCK: seq(0x55, 0x56, 0x57, 0x58, 0x59) as number[],
  LV: seq(0x34) as number[],
  SUPER_ER: seq(0x2C) as number[],
  SUPER_E: seq(0x84) as number[],
  SUPER_RE: seq(0xA0) as number[],
  UNK_SPACER: seq(0x77) as number[],
  UP_ARROW: seq(0x79) as number[],
  DOWN_ARROW: seq(0x7A) as number[],
  LEFT_ARROW: seq(0x7B) as number[],
  RIGHT_ARROW: seq(0x7C) as number[],
};
for (const [id, sym] of pairs<string>(TextIR.EXTRA_SYMBOL)) {
  const name = match(sym, "^{(.+)}$");
  if (name != null) GLYPH_TAGS[name as string] = seq(0x100 + (id as number)) as number[];
}

const KEYPAD_TAGS: Record<string, number> = {};
for (const [id, name] of pairs<string>(TextIR.KEYGFX)) KEYPAD_TAGS[name] = id as number;

// src/text.c:81
const KEYPAD_ICONS: Record<number, { tile: number; w: number; h: number }> = {
  [0x00]: { tile: 0x00, w: 8, h: 12 },
  [0x01]: { tile: 0x01, w: 8, h: 12 },
  [0x02]: { tile: 0x02, w: 16, h: 12 },
  [0x03]: { tile: 0x04, w: 16, h: 12 },
  [0x04]: { tile: 0x06, w: 24, h: 12 },
  [0x05]: { tile: 0x09, w: 24, h: 12 },
  [0x06]: { tile: 0x0C, w: 8, h: 12 },
  [0x07]: { tile: 0x0D, w: 8, h: 12 },
  [0x08]: { tile: 0x0E, w: 8, h: 12 },
  [0x09]: { tile: 0x0F, w: 8, h: 12 },
  [0x0A]: { tile: 0x20, w: 8, h: 12 },
  [0x0B]: { tile: 0x21, w: 8, h: 12 },
  [0x0C]: { tile: 0x22, w: 8, h: 12 },
};

const KEYPAD_PATHS: PathItem[] = [
  { path: "chrome/fonts/keypad_icons.rgba", w: 128, h: 32 },
  { path: "data/generated/gba/chrome/fonts/keypad_icons.rgba", w: 128, h: 32 },
];

const reportedTags: Record<string, boolean> = Object.create(null);
// Lua: frlg_font.lua:826
function unknownTag(tag: string): void {
  // NOT FAITHFUL: os.getenv("POKEPORT_DEV") does not exist on the 3DS; only the global flag is read
  if ((globalThis as { POKEPORT_DEV_MODE?: unknown }).POKEPORT_DEV_MODE === true) {
    throw new Error("FrlgFont: no glyph for text tag {" + tostring(tag) + "}");
  }
  if (!reportedTags[tag]) {
    reportedTags[tag] = true;
    log("no glyph for text tag {" + tostring(tag) + "}");
  }
}

// Lua: frlg_font.lua:836
function resolveColorId(val: unknown): Col | undefined {
  if (!truthy(val)) return undefined;
  if (typeof val === "number") return STDPAL[val];
  const up = upper(tostring(val));
  const id = hasOwn.call(COLOR_IDS, up) ? COLOR_IDS[up] : undefined;
  if (id !== undefined) return STDPAL[id];
  const num = tonumber(val);
  if (num !== undefined && STDPAL[num]) return STDPAL[num];
  return undefined;
}

const colorScratchPool: Colors[] = [
  null as unknown as Colors,
  { fg: undefined, shadow: undefined, bg: undefined },
  { fg: undefined, shadow: undefined, bg: undefined },
  { fg: undefined, shadow: undefined, bg: undefined },
  { fg: undefined, shadow: undefined, bg: undefined },
];
let colorScratchIdx = 0;

// Lua: frlg_font.lua:855
function acquireColorScratch(c: Colors | undefined): Colors {
  colorScratchIdx = (colorScratchIdx % 4) + 1;
  const cur = colorScratchPool[colorScratchIdx]!;
  if (!c) {
    cur.fg = STDPAL[2];
    cur.shadow = STDPAL[3];
    cur.bg = STDPAL[0];
  } else {
    cur.fg = c.fg || STDPAL[2];
    cur.shadow = c.shadow || STDPAL[3];
    cur.bg = c.bg || STDPAL[0];
  }
  return cur;
}

// src/text.c:740-787
const PEN_CODES: Record<number, string> = {
  [0x0D]: "shiftx",
  [0x0E]: "shifty",
  [0x11]: "clear",
  [0x12]: "skip",
  [0x13]: "clearto",
  [0x14]: "minspacing",
};

/**
 * One token of scanTokens: [type, value, colours]. The scanner reuses one
 * tuple per scan (destructure it before the next call), as Lua's multiple
 * returns allocate nothing.
 */
export type Token = [string, any, Colors];
export type TokenScanner = () => Token | undefined;

export const FrlgFont = {
  CELL: 16,
  MAX_LETTER_WIDTH: 10,
  GLYPH_HEIGHT: 14,
  LINE_PITCH: 15, // maxLetterHeight(14) + lineSpacing(1)
  STDPAL,
  COLOR_IDS,
  COLOR,
  NPC_TEXT_COLOR,
  SMALL_GLYPH_HEIGHT,
  SMALL_LINE_PITCH,

  _fg: undefined as Image | undefined,
  _sh: undefined as Image | undefined,
  _quads: undefined as Record<number, Quad> | undefined,
  _widths: undefined as LuaTable | undefined,
  _small: undefined as Sheet | undefined, // { fg, sh, quads, widths }
  _rev: undefined as Record<string, number> | undefined, // UTF-8 char → glyph id
  _logged: false,
  _atlas: undefined as Atlas | undefined,
  _keypad: undefined as Image | undefined,
  _jpNormal: undefined as Sheet | false | undefined,
  _jpSmall: undefined as Sheet | false | undefined,
  _jpWidths: undefined as LuaTable | undefined,
  _metrics: undefined as LuaTable | false | undefined,
  _specKey: undefined as string | undefined,

  _syncVersion: undefined as string | undefined,
  _spec: undefined as LuaTable | undefined,
  _faces: {} as Record<string, Face | false>,
  _stdpalSaved: undefined as Col[] | undefined,

  sync,
  face: faceFor,

  JAPANESE_BASE,
  JAPANESE_GLYPHS: {} as Record<string, number>,
  LATIN_GLYPHS,
  GLYPH_TAGS,
  KEYPAD_TAGS,
  KEYPAD_ICONS,

  // pret CHAR_RIGHT_ARROW = 0x7C, but gText_SelectorArrow2 ("▶") is charmap 0xEF.
  // Menu_InitCursor / RedrawMenuCursor print SelectorArrow2 — use 0xEF for the pip.
  CHAR_RIGHT_ARROW: 0x7C,
  CHAR_SELECTOR_ARROW: 0xEF, // gText_SelectorArrow2
  CHAR_LEFT_ARROW: 0x7B,
  CHAR_UP_ARROW: 0x79,
  CHAR_DOWN_ARROW: 0x7A,
  // CHAR_EXTRA_SYMBOL|CHAR_LV_2 → glyph 0x105 in latin_small (UpdateLvlInHealthbox).
  CHAR_LV_2: 0x105,
  CHAR_MALE: 0xB5,
  CHAR_FEMALE: 0xB6,
  CHAR_SLASH: 0xBA,

  utf8Chars,

  /** Lookup NPC text color enum from graphicsId (0=Male, 1=Female, 2=Mon, 3=Neutral). */
  // Lua: frlg_font.lua:173
  getNpcTextColor(graphicId: unknown): number {
    if (!truthy(graphicId)) return NPC_TEXT_COLOR.NEUTRAL;
    const spec = FrlgFont.sync ? FrlgFont.sync() : undefined;
    if (spec && spec.npcTextColors === false) return NPC_TEXT_COLOR.NEUTRAL;
    const gid = tonumber(graphicId);
    if (gid === undefined || gid < 0) return NPC_TEXT_COLOR.NEUTRAL;
    const idx = Math.floor(gid / 2);
    if (idx > 75 || sTextColorTable[idx] == null) {
      return NPC_TEXT_COLOR.NEUTRAL;
    }
    const shift = mod(gid, 2) * 4;
    const val = Math.floor(sTextColorTable[idx]! / 2 ** shift) % 16;
    return val;
  },

  /** Get 3-slot color table for an NPC graphicsId. */
  // Lua: frlg_font.lua:189
  colorForNpc(graphicId: unknown): Colors {
    const c = FrlgFont.getNpcTextColor(graphicId);
    if (c === NPC_TEXT_COLOR.MALE) {
      return COLOR.MALE_NPC!;
    } else if (c === NPC_TEXT_COLOR.FEMALE) {
      return COLOR.FEMALE_NPC!;
    } else {
      return COLOR.NORMAL!;
    }
  },

  // Lua: frlg_font.lua:468
  linePitch(opts?: FontOpts): number {
    const face = faceFor(opts);
    if (face) return face.pitch;
    return opts && opts.small ? SMALL_LINE_PITCH : FrlgFont.LINE_PITCH;
  },

  /**
   * Byte-by-byte token scanner for GBA FRLG text strings.
   * Handles \xFC bytecode sequences, {TAG} macros, and UTF-8 characters without choking on null bytes.
   */
  // Lua: frlg_font.lua:882
  scanTokens(text?: unknown, initialColors?: Colors): TokenScanner {
    const s = tostring(text != null ? text : "");
    const curColors = acquireColorScratch(initialColors);
    let i = 1;
    const n = s.length;
    let pending: number[] | undefined, pendingIdx = 0;
    const tok: Token = ["", undefined, curColors];
    const ret = (t: string, v: unknown): Token => { tok[0] = t; tok[1] = v; return tok; };

    return (): Token | undefined => {
      if (pending) {
        pendingIdx = pendingIdx + 1;
        const id = pending[pendingIdx];
        if (pendingIdx >= len(pending)) pending = undefined;
        return ret("glyph", id);
      }
      while (i <= n) {
        const b = s.charCodeAt(i - 1);

        // 1) 0xFC (EXT_CTRL_CODE)
        if (b === 0xFC && i + 1 <= n) {
          const cmd = s.charCodeAt(i);
          if (cmd === 0x01 && i + 2 <= n) { // EXT_CTRL_CODE_COLOR (3 bytes)
            const cid = s.charCodeAt(i + 1);
            curColors.fg = STDPAL[cid] || curColors.fg;
            i = i + 3;
            return ret("ctrl", "COLOR");
          } else if (cmd === 0x02 && i + 2 <= n) { // EXT_CTRL_CODE_HIGHLIGHT (3 bytes)
            const cid = s.charCodeAt(i + 1);
            curColors.bg = STDPAL[cid] || curColors.bg;
            i = i + 3;
            return ret("ctrl", "HIGHLIGHT");
          } else if (cmd === 0x03 && i + 2 <= n) { // EXT_CTRL_CODE_SHADOW (3 bytes)
            const cid = s.charCodeAt(i + 1);
            curColors.shadow = STDPAL[cid] || curColors.shadow;
            i = i + 3;
            return ret("ctrl", "SHADOW");
          } else if (cmd === 0x04 && i + 4 <= n) { // EXT_CTRL_CODE_COLOR_HIGHLIGHT_SHADOW (5 bytes)
            const fgId = s.charCodeAt(i + 1);
            const bgId = s.charCodeAt(i + 2);
            const shId = s.charCodeAt(i + 3);
            curColors.fg = STDPAL[fgId] || curColors.fg;
            curColors.bg = STDPAL[bgId] || curColors.bg;
            curColors.shadow = STDPAL[shId] || curColors.shadow;
            i = i + 5;
            return ret("ctrl", "COLOR_HIGHLIGHT_SHADOW");
          } else if (cmd === 0x06 && i + 2 <= n) { // EXT_CTRL_CODE_FONT (3 bytes)
            const fontId = s.charCodeAt(i + 1);
            const fontName = TextIR.dialect().FONT_IDS[fontId];
            if (fontName === "FONT_MALE") {
              curColors.fg = STDPAL[8];
              curColors.shadow = STDPAL[3];
              curColors.bg = STDPAL[0];
            } else if (fontName === "FONT_FEMALE") {
              curColors.fg = STDPAL[4];
              curColors.shadow = STDPAL[3];
              curColors.bg = STDPAL[0];
            } else if (fontName === "FONT_NORMAL") {
              curColors.fg = STDPAL[2];
              curColors.shadow = STDPAL[3];
              curColors.bg = STDPAL[0];
            }
            i = i + 3;
            return ret("ctrl", "FONT");
          } else if (PEN_CODES[cmd] !== undefined && i + 2 <= n) {
            const arg = s.charCodeAt(i + 1);
            i = i + 3;
            return ret(PEN_CODES[cmd]!, arg);
          } else if (cmd === 0x15 || cmd === 0x16) {
            i = i + 2;
            return ret("jpn", cmd === 0x15);
          } else {
            // Skip variable length commands according to pret text.c
            let skip = 2;
            if (cmd === 0x05 || cmd === 0x08 || cmd === 0x0C) {
              skip = 3;
            } else if (cmd === 0x0B || cmd === 0x10) {
              skip = 4;
            }
            i = i + skip;
            return ret("ctrl", "EXT");
          }

        // 2) Braced tag: {TAG}
        } else if (b === 0x7B) { // '{'
          const closeAt = s.indexOf("}", i);
          const closePos = closeAt >= 0 ? closeAt + 1 : undefined;
          if (closePos !== undefined) {
            const tag = s.substring(i, closePos - 1);
            const upperTag = upper(tag);
            i = closePos + 1;
            if (upperTag === "FONT_MALE") {
              curColors.fg = STDPAL[8];
              curColors.shadow = STDPAL[3];
              curColors.bg = STDPAL[0];
              return ret("ctrl", tag);
            } else if (upperTag === "FONT_FEMALE") {
              curColors.fg = STDPAL[4];
              curColors.shadow = STDPAL[3];
              curColors.bg = STDPAL[0];
              return ret("ctrl", tag);
            } else if (upperTag === "FONT_NORMAL") {
              curColors.fg = STDPAL[2];
              curColors.shadow = STDPAL[3];
              curColors.bg = STDPAL[0];
              return ret("ctrl", tag);
            } else if (upperTag.substring(0, 6) === "COLOR ") {
              const val = match(tag.substring(6), "^%s*(.-)%s*$");
              const col = resolveColorId(val);
              if (col) curColors.fg = col;
              return ret("ctrl", tag);
            } else if (upperTag.substring(0, 7) === "SHADOW ") {
              const val = match(tag.substring(7), "^%s*(.-)%s*$");
              const col = resolveColorId(val);
              if (col) curColors.shadow = col;
              return ret("ctrl", tag);
            } else if (upperTag.substring(0, 10) === "HIGHLIGHT " || upperTag.substring(0, 3) === "BG ") {
              const val = match(tag, "^%S+%s+(.-)%s*$");
              const col = resolveColorId(val);
              if (col) curColors.bg = col;
              return ret("ctrl", tag);
            } else if (hasOwn.call(GLYPH_TAGS, upperTag)) {
              const ids = GLYPH_TAGS[upperTag]!;
              if (len(ids) > 1) {
                pending = ids;
                pendingIdx = 1;
              }
              return ret("glyph", ids[1]);
            } else if (hasOwn.call(KEYPAD_TAGS, upperTag)) {
              return ret("icon", KEYPAD_TAGS[upperTag]);
            } else {
              unknownTag(tag);
              return ret("ctrl", tag);
            }
          } else {
            i = i + 1;
            return ret("char", "{");
          }

        // 3) Newline
        } else if (b === 0x0A) { // '\n'
          i = i + 1;
          return ret("nl", "\n");
        } else if (b === 0x0C) { // '\f'
          i = i + 1;
          return ret("page", "\f");
        } else if (b === 0x0D) { // '\r'
          i = i + 1;

        // 4) Regular UTF-8 char
        } else {
          let l = 1;
          if (b >= 0xF0) l = 4;
          else if (b >= 0xE0) l = 3;
          else if (b >= 0xC0) l = 2;
          if (i + l - 1 > n) l = 1;
          const ch = l === 1 ? s[i - 1]! : s.substring(i - 1, i - 1 + l);
          i = i + l;
          return ret("char", ch);
        }
      }
      return undefined;
    };
  },

  // Lua: frlg_font.lua:1043
  glyphId(ch?: string): number {
    if (!ch || ch === "") return 0x00;
    const rev = buildRev();
    const id = rev[ch];
    if (id !== undefined) return id;
    const b = ch.charCodeAt(0);
    if (b >= 0x20 && b < 0x7F && ch.length === 1) {
      return 0x00;
    }
    return 0x00;
  },

  // Lua: frlg_font.lua:1055
  advance(glyphId: number, opts?: FontOpts): number {
    opts = opts || {};
    if (glyphId >= JAPANESE_BASE) {
      // pokefirered/src/text.c:1391 (small: 8px), :1492 (normal: its width table).
      // The window's letter spacing is added by japanese_step, as the cart does.
      if (opts.small) return 8;
      return japanese_widths()[glyphId - JAPANESE_BASE] ?? 10;
    }
    const face = faceFor(opts);
    if (face) return faceAdvance(face, glyphId);
    if (opts.small) {
      ensure_small();
      const sw = FrlgFont._small ? FrlgFont._small.widths : undefined;
      let w = sw ? sw[glyphId] : undefined;
      if (w == null) {
        if (glyphId === 0x108) return 8;
        if (glyphId === 0xB7) return 6;
        w = (sw ? sw[0] : undefined) ?? 5;
      }
      return w;
    }
    ensure();
    let w = FrlgFont._widths[glyphId];
    if (w == null) {
      if (glyphId === 0x108) return 9;
      if (glyphId === 0xB7) return 7;
      w = FrlgFont._widths[0] ?? 6;
    }
    return w;
  },

  // Lua: frlg_font.lua:1104
  measure(text?: unknown, opts?: FontOpts): number {
    opts = opts || {};
    const ls = opts.letterSpacing ?? 0;
    let minW = 0, jpn = false;
    let line = 0, maxLine = 0;
    const next = FrlgFont.scanTokens(text);
    for (let t = next(); t; t = next()) {
      const ttype = t[0], val = t[1];
      if (ttype === "nl" || ttype === "page") {
        if (line > maxLine) maxLine = line;
        line = 0;
      } else if (ttype === "char") {
        const id = FrlgFont.glyphId(val);
        line = line + japanese_step(id, FrlgFont.advance(id, opts), minW, jpn, opts, opts.small);
      } else if (ttype === "glyph") {
        line = line + japanese_step(val, FrlgFont.advance(val, opts), minW, jpn, opts, opts.small);
      } else if (ttype === "icon") {
        line = line + KEYPAD_ICONS[val]!.w + ls;
      } else if (ttype === "clear") {
        line = line + val;
      } else if (ttype === "skip") {
        line = val;
      } else if (ttype === "clearto") {
        if (val > line) line = val;
      } else if (ttype === "minspacing") {
        minW = val;
      } else if (ttype === "jpn") {
        jpn = val;
      }
    }
    if (line > maxLine) maxLine = line;
    return maxLine;
  },

  // src/text.c:1335
  // Lua: frlg_font.lua:1139
  drawKeypadIcon(iconId: number, x: number, y: number): number {
    const icon = KEYPAD_ICONS[iconId]!;
    if (!FrlgFont._keypad) {
      FrlgFont._keypad = loadImage(KEYPAD_PATHS)[0];
      if (!FrlgFont._keypad) {
        throw new Error("FrlgFont: keypad_icons.rgba is not in the cache");
      }
      keypadQuads = undefined;
    }
    if (!keypadQuads) {
      const [iw, ih] = FrlgFont._keypad.getDimensions();
      keypadQuads = {};
      for (const [id, k] of pairs<{ tile: number; w: number; h: number }>(KEYPAD_ICONS)) {
        keypadQuads[id as number] = G.newQuad((k.tile % 16) * 8, Math.floor(k.tile / 16) * 8, k.w, k.h, iw, ih);
      }
    }
    G.setColor(1, 1, 1, 1);
    G.draw(FrlgFont._keypad, keypadQuads[iconId], x, y);
    return icon.w;
  },

  /** Word-wrap text to fit within maxWidth pixels. */
  // Lua: frlg_font.lua:1163
  wrap(text: string, maxWidth?: number, opts?: FontOpts): string {
    opts = opts || {};
    maxWidth = maxWidth || 200;
    const spaceW = FrlgFont.measure(" ", opts);
    const outLines: (string | null)[] = seq();
    const rawLines: (string | null)[] = seq();
    let clean = gsub(TextIR.protectExt(text), "\\n", "\n")[0];
    clean = gsub(clean, "\\p", "\n")[0];
    clean = gsub(clean, "\\l", "\n")[0];
    for (const [line] of gmatch(clean + "\n", "(.-)\r?\n")) {
      rawLines[len(rawLines) + 1] = line as string;
    }
    for (const [, rawLine] of ipairs<string>(rawLines)) {
      const words: (string | null)[] = seq();
      for (const [word] of gmatch(rawLine, "%S+")) {
        words[len(words) + 1] = word as string;
      }
      if (len(words) === 0) {
        outLines[len(outLines) + 1] = "";
      } else {
        let curLine = words[1]!;
        let curW = FrlgFont.measure(restore_ext(curLine), opts);
        for (let i = 2; i <= len(words); i++) {
          const w = words[i]!;
          const wW = FrlgFont.measure(restore_ext(w), opts);
          if (curW + spaceW + wW <= maxWidth) {
            curLine = curLine + " " + w;
            curW = curW + spaceW + wW;
          } else {
            outLines[len(outLines) + 1] = curLine;
            curLine = w;
            curW = wW;
          }
        }
        outLines[len(outLines) + 1] = curLine;
      }
    }
    return restore_ext(concat(outLines, "\n"));
  },

  /**
   * Draw full string at pixel (x,y).
   * opts.maxWidth clips (CopyGlyphToWindow). opts.colors = COLOR.NORMAL etc.
   * opts.limitChars: only draw first N printable characters (typewriter).
   * opts.small: use FONT_SMALL (party menu).
   * Returns [drawn, endX, endY].
   */
  // Lua: frlg_font.lua:1216
  draw(text: unknown, x: number, y: number, opts?: FontOpts): [number, number?, number?] {
    opts = opts || {};
    const face = faceFor(opts);
    let useSmall = false;
    if (face) {
      useSmall = face.name === "small";
    } else {
      if (opts.small) {
        useSmall = !!(ensure_small() && FrlgFont._small && FrlgFont._small._romBaked);
      }
      if (!useSmall && !ensure()) return [0];
    }

    let baseColors = opts.colors;
    if (!baseColors) {
      if (opts.color) {
        baseColors = {
          fg: opts.color,
          shadow: opts.shadow || (opts.color === COLOR.WHITE!.fg ? COLOR.WHITE!.shadow : COLOR.NORMAL!.shadow),
          bg: opts.bg || STDPAL[0],
        };
      } else if (truthy(opts.gfxId)) {
        baseColors = FrlgFont.colorForNpc(opts.gfxId);
      } else if (truthy(opts.npcColor)) {
        if (opts.npcColor === NPC_TEXT_COLOR.MALE) {
          baseColors = COLOR.MALE;
        } else if (opts.npcColor === NPC_TEXT_COLOR.FEMALE) {
          baseColors = COLOR.FEMALE;
        } else {
          baseColors = COLOR.NORMAL;
        }
      } else {
        baseColors = (useSmall ? COLOR.PARTY : undefined) || COLOR.NORMAL;
      }
    }

    const maxW = opts.maxWidth ?? 240;
    const limit = opts.limitChars;
    const ls = opts.letterSpacing ?? 0;
    let minW = 0, jpn = false;
    let penX = 0, penY = 0;
    let drawn = 0;
    const pitch = opts.linePitch ?? (face ? face.pitch : undefined)
      ?? (useSmall ? SMALL_LINE_PITCH : FrlgFont.LINE_PITCH);
    let fg: Image | undefined, sh: Image | undefined, quads: Record<number, Quad>, atlas: Atlas | undefined;
    if (face) {
      [fg, sh, quads, atlas] = [face.fg, face.sh, face.quads, face.atlas];
    } else if (useSmall) {
      const sm = FrlgFont._small!;
      [fg, sh, quads, atlas] = [sm.fg, sm.sh, sm.quads, sm.atlas];
    } else {
      [fg, sh, quads, atlas] = [FrlgFont._fg, FrlgFont._sh, FrlgFont._quads!, FrlgFont._atlas];
    }
    if (atlas && (atlas.src !== quads || !sh)) atlas = undefined;

    const next = FrlgFont.scanTokens(text, baseColors);
    for (let t = next(); t; t = next()) {
      const ttype = t[0], val = t[1], curCol = t[2];
      if (limit != null && drawn >= limit) break;
      if (ttype === "nl") {
        penX = 0;
        penY = penY + pitch;
        drawn = drawn + 1;
      } else if (ttype === "icon") {
        const w = KEYPAD_ICONS[val]!.w;
        if (penX + w <= maxW || penX === 0) {
          FrlgFont.drawKeypadIcon(val, x + penX, y + penY);
          penX = penX + w + ls;
        }
        drawn = drawn + 1;
      } else if (ttype === "shiftx" || ttype === "skip") {
        penX = val;
      } else if (ttype === "shifty") {
        penY = val;
      } else if (ttype === "clear") {
        penX = penX + val;
      } else if (ttype === "clearto") {
        if (val > penX) penX = val;
      } else if (ttype === "minspacing") {
        minW = val;
      } else if (ttype === "jpn") {
        jpn = val;
      } else if (ttype === "char" || ttype === "glyph") {
        const id: number = ttype === "glyph" ? val : FrlgFont.glyphId(val);
        let adv: number;
        if (face && id < JAPANESE_BASE) {
          adv = faceAdvance(face, id);
        } else {
          adv = FrlgFont.advance(id, useSmall ? ADVANCE_SMALL : ADVANCE_NORMAL);
        }
        if (penX + adv <= maxW || penX === 0) {
          const dx = x + penX, dy = y + penY;
          let gfg = fg, gsh = sh, q: Quad | undefined = quads[id], gat = atlas;
          let aid = id;
          if (id >= JAPANESE_BASE) {
            [gfg, gsh, q, gat] = japanese_quad(id, useSmall);
            aid = id - JAPANESE_BASE;
            if (!gsh) gat = undefined;
          }
          if (q) {
            // Draw background / highlight fill if bg is not transparent
            if (curCol.bg && curCol.bg[4] != null && curCol.bg[4] > 0) {
              set_col(curCol.bg);
              G.rectangle("fill", dx, dy, adv, pitch);
            }
            const aq = gat ? gat.fg[aid] : undefined;
            // Draw shadow
            if (gsh && curCol.shadow && (curCol.shadow[4] == null || curCol.shadow[4] > 0)) {
              set_col(curCol.shadow);
              if (aq) {
                G.draw(gat!.image, gat!.sh[aid], dx, dy);
              } else {
                G.draw(gsh, q, dx, dy);
              }
            }
            // Draw foreground
            if (curCol.fg && (curCol.fg[4] == null || curCol.fg[4] > 0)) {
              set_col(curCol.fg);
              if (aq) {
                G.draw(gat!.image, aq, dx, dy);
              } else {
                G.draw(gfg!, q, dx, dy);
              }
            }
          }
          penX = penX + japanese_step(id, adv, minW, jpn, opts, useSmall);
        }
        drawn = drawn + 1;
      }
    }
    G.setColor(1, 1, 1, 1);
    return [drawn, x + penX, y + penY];
  },

  /**
   * Draw a single glyph by FRLG charset id (e.g. 0x7C = CHAR_RIGHT_ARROW).
   * opts.small: FONT_SMALL sheet (supports EXTRA ids like CHAR_LV_2 = 0x105).
   */
  // Lua: frlg_font.lua:1349
  drawGlyph(glyphIdIn: unknown, x: number, y: number, opts?: FontOpts): number {
    opts = opts || {};
    const glyphId = tonumber(glyphIdIn) ?? 0;
    const face = faceFor(opts);
    let useSmall: boolean;
    if (face) {
      useSmall = face.name === "small";
    } else {
      useSmall = !!(opts.small && ensure_small() && FrlgFont._small && FrlgFont._small._romBaked);
      if (!useSmall && !ensure()) {
        return 0;
      }
    }
    const colors = opts.colors || (useSmall ? COLOR.PARTY! : undefined) || COLOR.NORMAL!;
    let fg: Image, sh: Image | undefined, quads: Record<number, Quad>;
    if (face) {
      [fg, sh, quads] = [face.fg, face.sh, face.quads];
    } else if (useSmall) {
      const sm = FrlgFont._small!;
      [fg, sh, quads] = [sm.fg, sm.sh, sm.quads];
    } else {
      [fg, sh, quads] = [FrlgFont._fg!, FrlgFont._sh, FrlgFont._quads!];
    }
    const q = quads[glyphId];
    if (!q) return 0;
    if (colors.bg && colors.bg[4] != null && colors.bg[4] > 0) {
      set_col(colors.bg);
      G.rectangle("fill", x, y,
        face ? faceAdvance(face, glyphId) : FrlgFont.advance(glyphId, useSmall ? ADVANCE_SMALL : ADVANCE_NORMAL),
        face ? face.pitch : (useSmall ? SMALL_LINE_PITCH : FrlgFont.LINE_PITCH));
    }
    if (sh && colors.shadow && (colors.shadow[4] == null || colors.shadow[4] > 0)) {
      set_col(colors.shadow);
      G.draw(sh, q, x, y);
    }
    if (colors.fg && (colors.fg[4] == null || colors.fg[4] > 0)) {
      set_col(colors.fg);
    } else {
      G.setColor(1, 1, 1, 1);
    }
    G.draw(fg, q, x, y);
    G.setColor(1, 1, 1, 1);
    if (face) return faceAdvance(face, glyphId);
    return FrlgFont.advance(glyphId, useSmall ? ADVANCE_SMALL : ADVANCE_NORMAL);
  },

  /**
   * The first n characters of text (UTF-8 aware): a name limit counts
   * characters (pokefirered POKEMON_NAME_LENGTH, PLAYER_NAME_LENGTH), and a kana
   * is three bytes, so a byte cut would split it.
   */
  // Lua: frlg_font.lua:1409
  truncate(textIn: unknown, n: number): string {
    const text = tostring(textIn != null ? textIn : "");
    const out: (string | null)[] = seq();
    let count = 0;
    const next = utf8Chars(text);
    for (let c = next(); c; c = next()) {
      if (count >= n) break;
      count = count + 1;
      out[count] = c[0];
    }
    return concat(out);
  },

  /** Count printable UTF-8 characters in text (including newlines, skipping control codes). */
  // Lua: frlg_font.lua:1420
  countChars(text: unknown): number {
    let n = 0;
    const next = FrlgFont.scanTokens(text);
    for (let t = next(); t; t = next()) {
      const ttype = t[0];
      if (ttype === "char" || ttype === "nl" || ttype === "glyph" || ttype === "icon") {
        n = n + 1;
      }
    }
    return n;
  },

  // Lua: frlg_font.lua:1430
  invalidate(): void {
    FrlgFont._faces = {};
    FrlgFont._metrics = undefined;
    FrlgFont._fg = undefined;
    FrlgFont._sh = undefined;
    FrlgFont._quads = undefined;
    FrlgFont._atlas = undefined;
    FrlgFont._small = undefined;
    FrlgFont._keypad = undefined;
    FrlgFont._jpNormal = undefined;
    FrlgFont._jpSmall = undefined;
    FrlgFont._jpWidths = undefined;
    FrlgFont._logged = false;
  },
};

FrlgFont.JAPANESE_GLYPHS = japanese_glyphs();

// src/text.c:841 / :1020 GetStringWidth
// Lua: frlg_font.lua:1087
function glyph_step(w: number, minW: number, jpn: boolean, ls: number): number {
  if (minW > 0) return minW > w ? minW : w;
  if (jpn) return w + ls;
  return w;
}

// A glyph drawn from a Japanese sheet is Japanese whether or not the string
// carries the {JPN} control code a ROM-extracted one does, so it takes the
// window's letter spacing either way (src/text.c:853).  Without one, the field
// message printer's spacing applies: 1 for the normal font
// (new_menu_helpers.c:413), 0 for the small one (gFontInfos, :65).
// Lua: frlg_font.lua:1098
function japanese_step(glyphId: number, w: number, minW: number, jpn: boolean, opts: FontOpts, small: unknown): number {
  const ls = opts.letterSpacing;
  if (glyphId < JAPANESE_BASE) return glyph_step(w, minW, jpn, ls ?? 0);
  return glyph_step(w, minW, true, ls ?? (small ? 0 : 1));
}

let keypadQuads: Record<number, Quad> | undefined = undefined;

const restore_ext = TextIR.restoreExt;

const ADVANCE_SMALL: FontOpts = { small: true };
const ADVANCE_NORMAL: FontOpts = {};

// Lua: frlg_font.lua:1204
function set_col(c: Col | undefined): void {
  if (c !== null && typeof c === "object") {
    G.setColor(c[1] ?? 1, c[2] ?? 1, c[3] ?? 1, c[4] ?? 1);
  } else {
    G.setColor(1, 1, 1, 1);
  }
}

// text_ir pcall-requires this module for its line wrapper
bindFrlgFont(FrlgFont);

export default FrlgFont;
