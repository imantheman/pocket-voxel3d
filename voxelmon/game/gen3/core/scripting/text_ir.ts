// Port of gen1recomp src/core/game3/scripting/text_ir.lua (GPLv3 + additional terms; see LICENSE.md).
// GBA text -> IR segments (glyphs + control codes FA/FB/FC/FD/FE/FF).
//
// Strings are BYTE strings (see voxelmon/import/gen3/lua.ts): the charmap's
// non-ASCII glyphs are the UTF-8 bytes the Lua source holds (é = "\xc3\xa9").
// Lua tables keyed by game codes stay objects keyed by those codes; IR
// segment lists are JS arrays (0-based). Lookups by NAME use own-property
// reads, so a name such as "constructor" misses as it does in Lua.

import { format, sub, tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { GameVersion } from "../../../../import/gen3/game_version.ts";
import { Profile } from "../profile.ts";

/** One IR segment, as the Lua builds it (only the fields that are set exist). */
export interface Seg {
  t: string;
  s?: string;
  n?: number;
  code?: number;
  name?: string;
  tag?: string;
  cmd?: number;
  args?: number[];
  font?: string;
  [k: string]: unknown;
}

export interface Dialect {
  name: string;
  PH_NAMES: Record<number, string>;
  B_TXT: Record<number, string>;
  B_TXT_CODE: Record<string, number>;
  FONT_IDS: Record<number, string>;
  CHARMAP_EXTRA?: Record<number, string>;
  CHARMAP_RUNS?: Record<number, { bytes: number[]; tag: string }>;
  GENDERED_PH?: Record<string, boolean>;
  placeholders?: string;
  PH_CODE: Record<string, number>;
  FONT_CODE: Record<string, number>;
  [k: string]: unknown;
}

/** A context provider (TextIR.setContextProvider). */
export type Provider = (kind: string, dialect: Dialect, ctx: any) => any;

/** The slice of src/ui/game3/frlg_font the line wrapper measures with. */
export interface FontMeasure { measure(text: string, opts?: unknown): number }

const hasOwn = Object.prototype.hasOwnProperty;
/** t[k] for a Lua table read by key (own properties only; nil -> undefined). */
function own<T>(t: Record<string | number, T> | undefined | null, k: string | number | undefined): T | undefined {
  if (t === undefined || t === null || k === undefined) return undefined;
  return hasOwn.call(t, k) ? t[k] : undefined;
}

/** A Lua table built with pairs-inversion (keys/values swapped). */
function invert<K extends string | number, V extends string | number>(t: Record<K, V>): Record<V, K> {
  // Lua: text_ir.lua:105
  const out = Object.create(null) as Record<V, K>;
  for (const k of Object.keys(t)) {
    const v = (t as Record<string, V>)[k]!;
    // keys of the source come back as strings; restore numeric keys as numbers
    (out as Record<string, unknown>)[String(v)] = /^-?\d+$/.test(k) ? Number(k) : k;
  }
  return out;
}

// FRLG English charmap (pret pokefirered/charmap.txt).
// CRITICAL: Gen2 uses $F0 for ¥; FRLG uses $F0 for ':' and $B7 for ¥.
// Mapping FRLG $F0 → "¥" produces BILL¥ / CELIO¥ in extracted text.
// Lua: text_ir.lua:8
const CHARMAP: Record<number, string> = {
  0x00: " ",
  0x1B: "\xc3\xa9", 0x06: "\xc3\x89",
  0x2D: "&", 0x2E: "+", 0x35: "=", 0x36: ";",
  0x5B: "%", 0x5C: "(", 0x5D: ")",
  0x85: "<", 0x86: ">",
  0xA1: "0", 0xA2: "1", 0xA3: "2", 0xA4: "3", 0xA5: "4",
  0xA6: "5", 0xA7: "6", 0xA8: "7", 0xA9: "8", 0xAA: "9",
  0xAB: "!", 0xAC: "?", 0xAD: ".", 0xAE: "-", 0xAF: "\xc2\xb7",
  0xB0: "\xe2\x80\xa6", 0xB1: "\xe2\x80\x9c", 0xB2: "\xe2\x80\x9d", 0xB3: "\xe2\x80\x98", 0xB4: "'",
  0xB5: "\xe2\x99\x82", 0xB6: "\xe2\x99\x80", 0xB7: "\xc2\xa5", 0xB8: ",", 0xB9: "\xc3\x97",
  0xBA: "/",
  0xBB: "A", 0xBC: "B", 0xBD: "C", 0xBE: "D", 0xBF: "E",
  0xC0: "F", 0xC1: "G", 0xC2: "H", 0xC3: "I", 0xC4: "J",
  0xC5: "K", 0xC6: "L", 0xC7: "M", 0xC8: "N", 0xC9: "O",
  0xCA: "P", 0xCB: "Q", 0xCC: "R", 0xCD: "S", 0xCE: "T",
  0xCF: "U", 0xD0: "V", 0xD1: "W", 0xD2: "X", 0xD3: "Y",
  0xD4: "Z",
  0xD5: "a", 0xD6: "b", 0xD7: "c", 0xD8: "d", 0xD9: "e",
  0xDA: "f", 0xDB: "g", 0xDC: "h", 0xDD: "i", 0xDE: "j",
  0xDF: "k", 0xE0: "l", 0xE1: "m", 0xE2: "n", 0xE3: "o",
  0xE4: "p", 0xE5: "q", 0xE6: "r", 0xE7: "s", 0xE8: "t",
  0xE9: "u", 0xEA: "v", 0xEB: "w", 0xEC: "x", 0xED: "y",
  0xEE: "z",
  0xEF: "\xe2\x96\xb6",
  0xF0: ":", // FRLG colon (NOT Gen2 yen)
};

// Lua: text_ir.lua:37
const CTRL = {
  SCROLL: 0xFA, // \l
  PARA: 0xFB, // \p
  NL: 0xFE, // \n
  EOS: 0xFF,
  PLACEHOLDER: 0xFD,
  EXT: 0xFC,
};

// FD nn placeholders (pret characters.h PLACEHOLDER_ID_*)
// Lua: text_ir.lua:47
const PH: Record<number, string> = {
  0x01: "player",
  0x02: "strvar1",
  0x03: "strvar2",
  0x04: "strvar3",
  0x06: "rival",
};

// charmap.txt:837-908
// Lua: text_ir.lua:56
const EXTRA_SYMBOL: Record<number, string> = {
  0x00: "\xe2\x86\x91", 0x01: "\xe2\x86\x93", 0x02: "\xe2\x86\x90", 0x03: "\xe2\x86\x92", 0x04: "{PLUS}",
  0x05: "{LV_2}", 0x06: "{PP}", 0x07: "{ID}", 0x08: "\xe2\x84\x96", 0x09: "_",
  0x0A: "\xe2\x91\xa0", 0x0B: "\xe2\x91\xa1", 0x0C: "\xe2\x91\xa2", 0x0D: "\xe2\x91\xa3", 0x0E: "\xe2\x91\xa4", 0x0F: "\xe2\x91\xa5",
  0x10: "\xe2\x91\xa6", 0x11: "\xe2\x91\xa7", 0x12: "\xe2\x91\xa8", 0x13: "{LEFT_PAREN}", 0x14: "{RIGHT_PAREN}",
  0x15: "\xe2\x97\x8e", 0x16: "\xe2\x96\xb3", 0x17: "\xe2\x9c\x95",
  0xD0: "{EMOJI_UNDERSCORE}", 0xD1: "{EMOJI_PIPE}", 0xD2: "{EMOJI_HIGHBAR}",
  0xD3: "{EMOJI_TILDE}", 0xD4: "{EMOJI_LEFT_PAREN}", 0xD5: "{EMOJI_RIGHT_PAREN}",
  0xD6: "{EMOJI_UNION}", 0xD7: "{EMOJI_GREATER_THAN}", 0xD8: "{EMOJI_LEFT_EYE}",
  0xD9: "{EMOJI_RIGHT_EYE}", 0xDA: "{EMOJI_AT}", 0xDB: "{EMOJI_SEMICOLON}",
  0xDC: "{EMOJI_PLUS}", 0xDD: "{EMOJI_MINUS}", 0xDE: "{EMOJI_EQUALS}",
  0xDF: "{EMOJI_SPIRAL}", 0xE0: "{EMOJI_TONGUE}", 0xE1: "{EMOJI_TRIANGLE_OUTLINE}",
  0xE2: "{EMOJI_ACUTE}", 0xE3: "{EMOJI_GRAVE}", 0xE4: "{EMOJI_CIRCLE}",
  0xE5: "{EMOJI_TRIANGLE}", 0xE6: "{EMOJI_SQUARE}", 0xE7: "{EMOJI_HEART}",
  0xE8: "{EMOJI_MOON}", 0xE9: "{EMOJI_NOTE}", 0xEA: "{EMOJI_BALL}",
  0xEB: "{EMOJI_BOLT}", 0xEC: "{EMOJI_LEAF}", 0xED: "{EMOJI_FIRE}",
  0xEE: "{EMOJI_WATER}", 0xEF: "{EMOJI_LEFT_FIST}", 0xF0: "{EMOJI_RIGHT_FIST}",
  0xF1: "{EMOJI_BIGWHEEL}", 0xF2: "{EMOJI_SMALLWHEEL}", 0xF3: "{EMOJI_SPHERE}",
  0xF4: "{EMOJI_IRRITATED}", 0xF5: "{EMOJI_MISCHIEVOUS}", 0xF6: "{EMOJI_HAPPY}",
  0xF7: "{EMOJI_ANGRY}", 0xF8: "{EMOJI_SURPRISED}", 0xF9: "{EMOJI_BIGSMILE}",
  0xFA: "{EMOJI_EVIL}", 0xFB: "{EMOJI_TIRED}", 0xFC: "{EMOJI_NEUTRAL}",
  0xFD: "{EMOJI_SHOCKED}", 0xFE: "{EMOJI_BIGANGER}",
};

// include/battle_message.h:9
// Lua: text_ir.lua:81
const B_TXT: Record<number, string> = {
  0x00: "B_BUFF1", 0x01: "B_BUFF2", 0x02: "B_COPY_VAR_1", 0x03: "B_COPY_VAR_2",
  0x04: "B_COPY_VAR_3", 0x05: "B_PLAYER_MON1_NAME", 0x06: "B_OPPONENT_MON1_NAME",
  0x07: "B_PLAYER_MON2_NAME", 0x08: "B_OPPONENT_MON2_NAME",
  0x09: "B_LINK_PLAYER_MON1_NAME", 0x0A: "B_LINK_OPPONENT_MON1_NAME",
  0x0B: "B_LINK_PLAYER_MON2_NAME", 0x0C: "B_LINK_OPPONENT_MON2_NAME",
  0x0D: "B_ATK_NAME_WITH_PREFIX_MON1", 0x0E: "B_ATK_PARTNER_NAME",
  0x0F: "B_ATK_NAME_WITH_PREFIX", 0x10: "B_DEF_NAME_WITH_PREFIX",
  0x11: "B_EFF_NAME_WITH_PREFIX", 0x12: "B_ACTIVE_NAME_WITH_PREFIX",
  0x13: "B_SCR_ACTIVE_NAME_WITH_PREFIX", 0x14: "B_CURRENT_MOVE", 0x15: "B_LAST_MOVE",
  0x16: "B_LAST_ITEM", 0x17: "B_LAST_ABILITY", 0x18: "B_ATK_ABILITY",
  0x19: "B_DEF_ABILITY", 0x1A: "B_SCR_ACTIVE_ABILITY", 0x1B: "B_EFF_ABILITY",
  0x1C: "B_TRAINER1_CLASS", 0x1D: "B_TRAINER1_NAME", 0x1E: "B_LINK_PLAYER_NAME",
  0x1F: "B_LINK_PARTNER_NAME", 0x20: "B_LINK_OPPONENT1_NAME",
  0x21: "B_LINK_OPPONENT2_NAME", 0x22: "B_LINK_SCR_TRAINER_NAME",
  0x23: "B_PLAYER_NAME", 0x24: "B_TRAINER1_LOSE_TEXT", 0x25: "B_TRAINER1_WIN_TEXT",
  0x26: "B_26", 0x27: "B_PC_CREATOR_NAME", 0x28: "B_ATK_PREFIX1",
  0x29: "B_DEF_PREFIX1", 0x2A: "B_ATK_PREFIX2", 0x2B: "B_DEF_PREFIX2",
  0x2C: "B_ATK_PREFIX3", 0x2D: "B_DEF_PREFIX3", 0x2E: "B_TRAINER2_LOSE_TEXT",
  0x2F: "B_TRAINER2_WIN_TEXT", 0x30: "B_BUFF3",
};
// Lua: text_ir.lua:102
const B_TXT_CODE = invert(B_TXT);

// pokeemerald/include/battle_message.h:57
// Lua: text_ir.lua:112
const B_TXT_RSE: Record<number, string> = {};
for (const k of Object.keys(B_TXT)) {
  const code = Number(k);
  if (code < 0x2E) B_TXT_RSE[code] = B_TXT[code]!;
}
B_TXT_RSE[0x2E] = "B_TRAINER2_CLASS";
B_TXT_RSE[0x2F] = "B_TRAINER2_NAME";
B_TXT_RSE[0x30] = "B_TRAINER2_LOSE_TEXT";
B_TXT_RSE[0x31] = "B_TRAINER2_WIN_TEXT";
B_TXT_RSE[0x32] = "B_PARTNER_CLASS";
B_TXT_RSE[0x33] = "B_PARTNER_NAME";
B_TXT_RSE[0x34] = "B_BUFF3";

// Lua: text_ir.lua:124
const DIALECTS: Record<string, Dialect> = {
  frlg: {
    name: "frlg",
    // pokefirered/include/characters.h:267
    PH_NAMES: {
      0x00: "UNKNOWN", 0x01: "PLAYER", 0x02: "STR_VAR_1", 0x03: "STR_VAR_2",
      0x04: "STR_VAR_3", 0x05: "KUN", 0x06: "RIVAL", 0x07: "VERSION",
      0x08: "MAGMA", 0x09: "AQUA", 0x0A: "MAXIE", 0x0B: "ARCHIE",
      0x0C: "GROUDON", 0x0D: "KYOGRE",
    },
    B_TXT,
    B_TXT_CODE,
    // pokefirered/include/text.h:16
    FONT_IDS: {
      0: "FONT_SMALL", 1: "FONT_NORMAL_COPY_1", 2: "FONT_NORMAL",
      3: "FONT_NORMAL_COPY_2", 4: "FONT_MALE", 5: "FONT_FEMALE",
      6: "FONT_BRAILLE", 7: "FONT_BOLD",
    },
  } as unknown as Dialect,
  rse: {
    name: "rse",
    // pokeemerald/include/constants/characters.h:251
    PH_NAMES: {
      0x00: "UNKNOWN", 0x01: "PLAYER", 0x02: "STR_VAR_1", 0x03: "STR_VAR_2",
      0x04: "STR_VAR_3", 0x05: "KUN", 0x06: "RIVAL", 0x07: "VERSION",
      0x08: "AQUA", 0x09: "MAGMA", 0x0A: "ARCHIE", 0x0B: "MAXIE",
      0x0C: "KYOGRE", 0x0D: "GROUDON",
    },
    B_TXT: B_TXT_RSE,
    B_TXT_CODE: invert(B_TXT_RSE),
    // pokeemerald/include/text.h:12
    FONT_IDS: {
      0: "FONT_SMALL", 1: "FONT_NORMAL", 2: "FONT_SHORT", 3: "FONT_SHORT_COPY_1",
      4: "FONT_SHORT_COPY_2", 5: "FONT_SHORT_COPY_3", 6: "FONT_BRAILLE",
      7: "FONT_NARROW", 8: "FONT_SMALL_NARROW", 9: "FONT_BOLD",
    },
    // pokeemerald/charmap.txt:45
    CHARMAP_EXTRA: {
      0x34: "{LV}",
      0x55: "{POKEBLOCK}", 0x56: "", 0x57: "", 0x58: "", 0x59: "",
      0x77: "{UNK_SPACER}",
      0x79: "{UP_ARROW}", 0x7A: "{DOWN_ARROW}", 0x7B: "{LEFT_ARROW}", 0x7C: "{RIGHT_ARROW}",
    },
    // pokeemerald/charmap.txt:52
    CHARMAP_RUNS: {
      0x55: { bytes: [0x55, 0x56, 0x57, 0x58, 0x59], tag: "{POKEBLOCK}" },
    },
    // pokeemerald/src/string_util.c:456
    GENDERED_PH: { KUN: true, RIVAL: true },
    placeholders: "data/generated/gba/text/placeholders.lua",
  } as unknown as Dialect,
};
// Lua: text_ir.lua:176
for (const k of Object.keys(DIALECTS)) {
  const d = DIALECTS[k]!;
  d.PH_CODE = invert(d.PH_NAMES);
  d.FONT_CODE = invert(d.FONT_IDS);
}

// Lua: text_ir.lua:203
const KEYGFX: Record<number, string> = {
  0x00: "A_BUTTON", 0x01: "B_BUTTON", 0x02: "L_BUTTON", 0x03: "R_BUTTON",
  0x04: "START_BUTTON", 0x05: "SELECT_BUTTON", 0x06: "DPAD_UP", 0x07: "DPAD_DOWN",
  0x08: "DPAD_LEFT", 0x09: "DPAD_RIGHT", 0x0A: "DPAD_UPDOWN", 0x0B: "DPAD_LEFTRIGHT",
  0x0C: "DPAD_ANY",
};

// charmap.txt:50
// Lua: text_ir.lua:211
const LIGATURE: Record<number, string> = { 0x53: "{PK}", 0x54: "{MN}" };

// src/text.c:948
// Lua: text_ir.lua:214
const EXT_ARGS: Record<number, number> = {
  0x01: 1, 0x02: 1, 0x03: 1, 0x04: 3, 0x05: 1, 0x06: 1, 0x08: 1,
  0x0B: 2, 0x0C: 1, 0x0D: 1, 0x0E: 1, 0x10: 2, 0x11: 1, 0x12: 1,
  0x13: 1, 0x14: 1,
};

/** s:byte(i) (1-based; undefined past the end). */
function byteAt(s: string, i: number): number | undefined {
  return i >= 1 && i <= s.length ? s.charCodeAt(i - 1) : undefined;
}

// Lua: text_ir.lua:220
function ext_len(s: string, i: number): number {
  return 2 + (own(EXT_ARGS, byteAt(s, i + 1)) ?? 0);
}

// Lua: text_ir.lua:273
const TAG_NAMES: Record<string, boolean> = Object.assign(Object.create(null) as Record<string, boolean>, { PK: true, MN: true, PKMN: true });
for (const k of Object.keys(KEYGFX)) TAG_NAMES[KEYGFX[Number(k)]!] = true;
const TAG_RE = /^\{([\s\S]+)\}$/;
for (const k of Object.keys(EXTRA_SYMBOL)) {
  const m = TAG_RE.exec(EXTRA_SYMBOL[Number(k)]!);
  if (m) TAG_NAMES[m[1]!] = true;
}
for (const dk of Object.keys(DIALECTS)) {
  const extra = DIALECTS[dk]!.CHARMAP_EXTRA ?? {};
  for (const k of Object.keys(extra)) {
    const m = TAG_RE.exec(extra[Number(k)]!);
    if (m) TAG_NAMES[m[1]!] = true;
  }
}

/** frlg_font, bound by its module once ported (the Lua pcall-requires it; unbound = require failed). */
let frlgFont: FontMeasure | undefined;
export function bindFrlgFont(font: FontMeasure | undefined): void {
  frlgFont = font;
}

// Lua: text_ir.lua:301
function is_female(g: unknown): boolean {
  return g === 1 || g === "female" || g === "F" || g === "girl";
}

// pokeemerald/src/string_util.c:456
// Lua: text_ir.lua:306
function gendered_ph(name: string, ctx: any): any {
  const d = TextIR.dialect(ctx ? ctx.dialect : undefined);
  if (!(d.GENDERED_PH && truthy(own(d.GENDERED_PH, name)))) return undefined;
  const ph = TextIR.placeholdersFor(ctx);
  const by = truthy(ph) && truthy(ph.byGender) ? own(ph.byGender, name) : undefined;
  if (by === null || typeof by !== "object") return undefined;
  let g = ctx ? ctx.playerGender : undefined;
  if (g == null && TextIR._provider) g = TextIR._provider("gender", d, ctx);
  if (is_female(g)) return (by as any).female;
  return (by as any).male;
}

// pokeemerald/src/string_util.c:428
// Lua: text_ir.lua:319
function live(field: string, ctx: any): any {
  const v = ctx ? ctx[field] : undefined;
  if (v != null) return v;
  const provider = TextIR._provider;
  if (!provider) return undefined;
  return provider(field, TextIR.dialect(ctx ? ctx.dialect : undefined), ctx);
}

// Lua: text_ir.lua:327
function player_name(ctx: any): any {
  const v = live("playerName", ctx);
  return truthy(v) ? v : "PLAYER";
}

// Lua: text_ir.lua:331 -- stringVars keep Lua's keys (1..3)
function string_var(n: number, ctx: any): any {
  const sv = live("stringVars", ctx);
  const v = sv !== null && typeof sv === "object" ? sv[n] : undefined;
  return truthy(v) ? v : "";
}

// Lua: text_ir.lua:336
function rival_name(ctx: any): any {
  const v = gendered_ph("RIVAL", ctx);
  if (v != null) return v;
  const r = live("rivalName", ctx);
  return truthy(r) ? r : "RIVAL";
}

// Lua: text_ir.lua:342 -- ctx.dynamic / ctx.battle keep Lua's keys (the raw byte / code)
function expand_seg(seg: Seg, ctx?: any): any {
  const t = seg.t;
  if (t === "text") {
    return seg.s;
  } else if (t === "dynamic") {
    const dyn = ctx ? ctx.dynamic : undefined;
    const v = truthy(dyn) ? dyn[seg.n!] : dyn;
    return truthy(v) ? v : "";
  } else if (t === "player") {
    return player_name(ctx);
  } else if (t === "rival") {
    return rival_name(ctx);
  } else if (t === "strvar") {
    return string_var(seg.n!, ctx);
  } else if (t === "tag") {
    return seg.tag;
  } else if (t === "bph") {
    // ctx and ctx.battle and ctx.battle[seg.code]
    const value = !truthy(ctx) ? ctx : !truthy(ctx.battle) ? ctx.battle : ctx.battle[seg.code!];
    if (value == null) {
      const names = ctx && truthy(ctx.dialect) ? TextIR.dialect(ctx.dialect).B_TXT : B_TXT;
      const nm = own(names, seg.code);
      throw new Error("battle text placeholder {" + tostring(truthy(nm) ? nm : seg.code) + "} has no value");
    }
    return value;
  } else if (t === "ph") {
    // Cached extracts may still store FD 06 as { t="ph", code=6 }.
    const code = tonumber(seg.code);
    const name = seg.name;
    if (code === 0x01 || name === "PLAYER") {
      return player_name(ctx);
    }
    if (code === 0x06 || name === "RIVAL") {
      return rival_name(ctx);
    }
    if (code !== undefined && code >= 0x02 && code <= 0x04) {
      return string_var(code - 1, ctx);
    }
    if (name === "STR_VAR_1" || name === "STR_VAR_2" || name === "STR_VAR_3") {
      return string_var(tonumber(sub(name, -1)) ?? 1, ctx);
    }
    if (name != null && (name === "FONT_MALE" || name === "FONT_FEMALE" || name === "FONT_NORMAL"
        || name.startsWith("COLOR") || name.startsWith("SHADOW") || name.startsWith("HIGHLIGHT") || name.startsWith("BG"))) {
      return "{" + name + "}";
    }
    // pokeemerald/src/string_util.c:464
    const placeholders = TextIR.placeholdersFor(ctx);
    if (truthy(placeholders)) {
      const pname = name ?? (code !== undefined ? own(TextIR.dialect(ctx ? ctx.dialect : undefined).PH_NAMES, code) : undefined);
      const g = pname != null ? gendered_ph(pname, ctx) : undefined;
      if (g != null) return g;
      if (pname != null && truthy(own(placeholders, pname))) return placeholders[pname];
    }
    return "";
  }
  return undefined;
}

// Lua: text_ir.lua:400
function flush_text(out: Seg[], buf: string[]): void {
  if (buf.length > 0) {
    out.push({ t: "text", s: buf.join("") });
  }
}

// Lua: text_ir.lua:588
const NAMED: Record<string, string> = { player: "{PLAYER}", rival: "{RIVAL}" };

// Lua: text_ir.lua:626
const ASCII_BREAK: Record<string, string> = { nl: "\n", scroll: "\\l", para: "\\p" };

/** Lua's %S+ (C isspace: space \t \n \v \f \r -- not JS \s, which also takes \xa0). */
const NONSPACE_RE = /[^ \t\n\v\f\r]+/g;
function words(s: string): string[] {
  return s.match(NONSPACE_RE) ?? [];
}

// Lua: text_ir.lua:679
function wrap_subline(lineStr: string, maxW?: number): string[] {
  if (!lineStr || lineStr === "") return [""];
  maxW = maxW ?? 208;
  const FrlgFont = frlgFont;
  if (FrlgFont && FrlgFont.measure) {
    const measure = (str: string): number => FrlgFont.measure(TextIR.restoreExt(str));
    const curW = measure(lineStr);
    if (curW <= maxW) {
      return [lineStr];
    }
    const spaceW = FrlgFont.measure(" ");
    const ws = words(lineStr);
    if (ws.length === 0) return [""];
    const out: string[] = [];
    let cur = ws[0]!;
    let curLineWidth = measure(cur);
    for (let i = 1; i < ws.length; i++) {
      const w = ws[i]!;
      const wW = measure(w);
      if (curLineWidth + spaceW + wW <= maxW) {
        cur = cur + " " + w;
        curLineWidth = curLineWidth + spaceW + wW;
      } else {
        out.push(cur);
        cur = w;
        curLineWidth = wW;
      }
    }
    out.push(cur);
    return out;
  } else {
    const maxChars = Math.floor(maxW / 6);
    const len = (str: string): number => TextIR.restoreExt(str).length;
    if (len(lineStr) <= maxChars) return [lineStr];
    const ws = words(lineStr);
    if (ws.length === 0) return [""];
    const out: string[] = [];
    let cur = ws[0]!;
    for (let i = 1; i < ws.length; i++) {
      const w = ws[i]!;
      if (len(cur) + 1 + len(w) <= maxChars) {
        cur = cur + " " + w;
      } else {
        out.push(cur);
        cur = w;
      }
    }
    out.push(cur);
    return out;
  }
}

/** Options of TextIR.toSource. */
export interface SourceOpts { para?: string; nl?: string; scroll?: string; named?: unknown; digits?: unknown; trim?: unknown }

export const TextIR = {
  CHARMAP,
  CTRL,
  PH,
  EXTRA_SYMBOL,
  B_TXT,
  B_TXT_CODE,
  DIALECTS,
  DEFAULT_DIALECT: "frlg",
  KEYGFX,
  LIGATURE,
  EXT_ARGS,
  TAG_NAMES,
  _provider: undefined as Provider | undefined,

  // Lua: text_ir.lua:183
  dialectOf(version?: string): string {
    const id = version ?? GameVersion.get();
    let family: unknown = GameVersion.layout ? GameVersion.layout(id) : undefined;
    if (family == null) {
      // NOT FAITHFUL (scope): the Lua consults profile only if it is already
      // loaded (package.loaded); here it is always importable.
      let ok = false, row: unknown;
      if (Profile && Profile.isGame3Version && Profile.isGame3Version(id)) {
        try { row = Profile.of(id); ok = true; } catch { ok = false; }
      }
      family = ok && row !== null && typeof row === "object" ? (row as Record<string, unknown>).family : undefined;
    }
    return typeof family === "string" && own(DIALECTS, family) ? family : TextIR.DEFAULT_DIALECT;
  },

  // Lua: text_ir.lua:198
  dialect(which?: unknown): Dialect {
    if (which !== null && typeof which === "object") return which as Dialect;
    const key = truthy(which) ? which : TextIR.dialectOf();
    return own(DIALECTS, key as string) ?? DIALECTS[TextIR.DEFAULT_DIALECT]!;
  },

  // src/text.c:670
  // Lua: text_ir.lua:225
  protectExt(s?: unknown): string {
    const str = tostring(truthy(s) ? s : "");
    if (!str.includes("\xfc")) return str;
    const out: string[] = [];
    let i = 1;
    const n = str.length;
    while (i <= n) {
      const b = str.charCodeAt(i - 1);
      if (b === 0xFC && i < n) {
        const last = Math.min(n, i + ext_len(str, i) - 1);
        const hex: string[] = [];
        for (let k = i + 1; k <= last; k++) hex.push(format("%02X", str.charCodeAt(k - 1)));
        out.push("\xff" + hex.join("") + "\xfe");
        i = last + 1;
      } else {
        out.push(String.fromCharCode(b));
        i = i + 1;
      }
    }
    return out.join("");
  },

  // Lua: text_ir.lua:245
  restoreExt(s?: unknown): string {
    return tostring(truthy(s) ? s : "").replace(/\xff([0-9A-Fa-f]+)\xfe/g, (_m, h: string) =>
      "\xfc" + h.replace(/[0-9A-Fa-f]{2}/g, (x) => String.fromCharCode(parseInt(x, 16))));
  },

  // src/text.c:670
  // Lua: text_ir.lua:252
  splitPages(box?: unknown, keepEmpty?: unknown): string[] {
    const s = tostring(truthy(box) ? box : "");
    const pages: string[] = [];
    let start = 1, i = 1;
    const n = s.length;
    while (i <= n) {
      const b = s.charCodeAt(i - 1);
      if (b === 0xFC && i < n) {
        i = i + ext_len(s, i);
      } else if (b === 0x0C) {
        const page = sub(s, start, i - 1);
        if (truthy(keepEmpty) || page !== "") pages.push(page);
        i = i + 1;
        start = i;
      } else {
        i = i + 1;
      }
    }
    const page = sub(s, start);
    if (truthy(keepEmpty) || page !== "") pages.push(page);
    return pages;
  },

  // Lua: text_ir.lua:288
  setContextProvider(fn: unknown): void {
    TextIR._provider = typeof fn === "function" ? (fn as Provider) : undefined;
  },

  // Lua: text_ir.lua:292
  placeholdersFor(ctx: any): any {
    if (ctx && truthy(ctx.placeholders)) return ctx.placeholders;
    const provider = TextIR._provider;
    if (!provider) return undefined;
    const d = TextIR.dialect(ctx ? ctx.dialect : undefined);
    if (!truthy(d.placeholders)) return undefined;
    return provider("placeholders", d, ctx);
  },

  // Lua: text_ir.lua:398
  expandSeg: expand_seg,

  /**
   * Decode raw GBA string bytes into IR. `bytes` is a byte string, or a
   * 0-based byte array (the Lua's 1-based table).
   */
  // Lua: text_ir.lua:407
  decode(bytes: string | ArrayLike<number>, opts?: { battle?: unknown; dialect?: unknown } | null): Seg[] {
    const battle = opts ? opts.battle : undefined;
    const dialect = TextIR.dialect(opts ? opts.dialect : undefined);
    const named = dialect.name !== TextIR.DEFAULT_DIALECT;
    const extra = dialect.CHARMAP_EXTRA, runs = dialect.CHARMAP_RUNS;
    const out: Seg[] = [];
    let buf: string[] = [];
    let i = 1;
    const n = bytes.length;
    const isStr = typeof bytes === "string";
    const b = (idx: number): number | undefined => {
      if (isStr) return byteAt(bytes as string, idx);
      return idx >= 1 ? (bytes as ArrayLike<number>)[idx - 1] : undefined;
    };
    while (i <= n) {
      const c = b(i)!;
      if (c === 0xFF) {
        flush_text(out, buf); buf = [];
        out.push({ t: "eos" });
        break;
      } else if (c === 0xFE) {
        flush_text(out, buf); buf = [];
        out.push({ t: "nl" });
        i = i + 1;
      } else if (c === 0xFA) {
        flush_text(out, buf); buf = [];
        out.push({ t: "scroll" });
        i = i + 1;
      } else if (c === 0xFB) {
        flush_text(out, buf); buf = [];
        out.push({ t: "para" });
        i = i + 1;
      } else if (c === 0xFD) {
        flush_text(out, buf); buf = [];
        const nn = b(i + 1) ?? 0;
        if (truthy(battle)) {
          out.push({ t: "bph", code: nn });
        } else if (nn === 0x01) {
          out.push({ t: "player" });
        } else if (nn === 0x06) {
          out.push({ t: "rival" });
        } else if (nn >= 0x02 && nn <= 0x04) {
          out.push({ t: "strvar", n: nn - 1 });
        } else if (named) {
          const seg: Seg = { t: "ph", code: nn };
          const name = own(dialect.PH_NAMES, nn);
          if (name !== undefined) seg.name = name;
          out.push(seg);
        } else {
          out.push({ t: "ph", code: nn });
        }
        i = i + 2;
      } else if (c === 0xF7) {
        flush_text(out, buf); buf = [];
        out.push({ t: "dynamic", n: b(i + 1) ?? 0 });
        i = i + 2;
      } else if (c === 0xF8) {
        flush_text(out, buf); buf = [];
        const key = own(KEYGFX, b(i + 1) ?? -1);
        out.push({ t: "tag", tag: key !== undefined ? "{" + key + "}" : "" });
        i = i + 2;
      } else if (c === 0xF9) {
        const sym = own(EXTRA_SYMBOL, b(i + 1) ?? -1);
        if (sym !== undefined && sub(sym, 1, 1) === "{") {
          flush_text(out, buf); buf = [];
          out.push({ t: "tag", tag: sym });
        } else {
          buf.push(sym ?? "?");
        }
        i = i + 2;
      } else if (c === 0xFC) {
        flush_text(out, buf); buf = [];
        const cmd = b(i + 1) ?? 0;
        const nargs = own(EXT_ARGS, cmd) ?? 0;
        const args: number[] = []; // Lua args[k] (k = 1..nargs) -> args[k - 1]
        for (let k = 1; k <= nargs; k++) args.push(b(i + 1 + k) ?? 0);
        const seg: Seg = { t: "ext", cmd, args };
        out.push(seg);
        if (named && cmd === 0x06) {
          const font = own(dialect.FONT_IDS, args[0]);
          if (font !== undefined) seg.font = font;
        }
        i = i + 2 + nargs;
      } else {
        const g = own(CHARMAP, c);
        if (g !== undefined) {
          buf.push(g);
          i = i + 1;
        } else if (own(LIGATURE, c) !== undefined) {
          flush_text(out, buf); buf = [];
          if (c === 0x53 && b(i + 1) === 0x54) {
            out.push({ t: "tag", tag: "{PKMN}" });
            i = i + 2;
          } else {
            out.push({ t: "tag", tag: LIGATURE[c]! });
            i = i + 1;
          }
        } else if (extra && own(extra, c) !== undefined) {
          const run = runs ? own(runs, c) : undefined;
          let len = 0;
          if (run) {
            len = run.bytes.length;
            for (let k = 1; k <= len; k++) {
              if (b(i + k - 1) !== run.bytes[k - 1]) { len = 0; break; }
            }
          }
          const tag = len > 0 ? run!.tag : extra[c]!;
          if (tag !== "") {
            flush_text(out, buf); buf = [];
            out.push({ t: "tag", tag });
          }
          i = i + Math.max(len, 1);
        } else {
          buf.push("?");
          i = i + 1;
        }
      }
    }
    flush_text(out, buf);
    return out;
  },

  /** Build IR from pret-style ASCII with \n \p \l {PLAYER} {STR_VAR_1} … */
  // Lua: text_ir.lua:520
  fromAscii(s: string, opts?: { dialect?: unknown } | null): Seg[] {
    const bcodes = TextIR.dialect(opts ? opts.dialect : undefined).B_TXT_CODE;
    const out: Seg[] = [];
    let buf: string[] = [];
    let i = 1;
    while (i <= s.length) {
      const ch = s.charAt(i - 1);
      if (ch === "\xfc" && i < s.length) {
        const len = ext_len(s, i);
        buf.push(sub(s, i, i + len - 1));
        i = i + len;
      } else if (ch === "\\" && i < s.length) {
        const n = s.charAt(i);
        flush_text(out, buf); buf = [];
        if (n === "n") out.push({ t: "nl" });
        else if (n === "p") out.push({ t: "para" });
        else if (n === "l") out.push({ t: "scroll" });
        else if (n === "f") out.push({ t: "para" });
        else buf.push("\\" + n);
        i = i + 2;
      } else if (ch === "\n") {
        flush_text(out, buf); buf = [];
        out.push({ t: "nl" });
        i = i + 1;
      } else if (ch === "\f") {
        flush_text(out, buf); buf = [];
        out.push({ t: "para" });
        i = i + 1;
      } else if (ch === "\r") {
        i = i + 1;
      } else if (ch === "{") {
        const jx = s.indexOf("}", i - 1);
        const j = jx < 0 ? undefined : jx + 1;
        const e = s.indexOf("\xfc", i - 1);
        if (j === undefined || (e >= 0 && e + 1 < j)) {
          buf.push(ch); i = i + 1;
        } else {
          flush_text(out, buf); buf = [];
          const name = sub(s, i + 1, j - 1);
          if (name === "PLAYER") {
            out.push({ t: "player" });
          } else if (name === "RIVAL") {
            out.push({ t: "rival" });
          } else if (name === "STR_VAR_1") {
            out.push({ t: "strvar", n: 1 });
          } else if (name === "STR_VAR_2") {
            out.push({ t: "strvar", n: 2 });
          } else if (name === "STR_VAR_3") {
            out.push({ t: "strvar", n: 3 });
          } else if (own(bcodes, name) !== undefined) {
            out.push({ t: "bph", code: bcodes[name]! });
          } else if (own(TAG_NAMES, name)) {
            out.push({ t: "tag", tag: "{" + name + "}" });
          } else if (name === "FONT_MALE" || name === "FONT_FEMALE" || name === "FONT_NORMAL"
              || name.startsWith("COLOR") || name.startsWith("SHADOW") || name.startsWith("HIGHLIGHT") || name.startsWith("BG")) {
            out.push({ t: "tag", tag: "{" + name + "}" });
          } else {
            out.push({ t: "ph", name });
          }
          i = j + 1;
        }
      } else {
        buf.push(ch);
        i = i + 1;
      }
    }
    flush_text(out, buf);
    out.push({ t: "eos" });
    return out;
  },

  /** [source, args (the Lua's sequence, 0-based), suffix] */
  // Lua: text_ir.lua:590
  toSource(ir: Seg[] | undefined | null, ctx?: any, opts?: SourceOpts | null): [string, any[], string] {
    const o: SourceOpts = opts ?? {};
    const para = truthy(o.para) ? o.para! : "\\p";
    const parts: string[] = [], args: any[] = [];
    for (const seg of ir ?? []) {
      const t = seg.t;
      if (t === "eos") {
        break;
      } else if (t === "nl") {
        parts.push(truthy(o.nl) ? o.nl! : "\n");
      } else if (t === "scroll") {
        parts.push(truthy(o.scroll) ? o.scroll! : truthy(o.nl) ? o.nl! : "\n");
      } else if (t === "para") {
        parts.push(para);
      } else if (t === "text" || t === "tag") {
        parts.push((expand_seg(seg, ctx) as string).replace(/%/g, "%%"));
      } else if (truthy(o.named) && (own(NAMED, t) !== undefined || t === "strvar")) {
        parts.push(own(NAMED, t) ?? ("{STR_VAR_" + tostring(seg.n) + "}"));
      } else if (t !== "ext") {
        const value = expand_seg(seg, ctx);
        if (value != null) {
          parts.push((truthy(o.digits) && /^[0-9]+$/.test(tostring(value))) ? "%d" : "%s");
          args.push(value);
        }
      }
    }
    let suffix = "";
    if (truthy(o.trim)) {
      const nl = truthy(o.nl) ? o.nl : "\n";
      while (parts.length > 0 && (parts[parts.length - 1] === para || parts[parts.length - 1] === nl
          || parts[parts.length - 1] === o.scroll)) {
        suffix = parts.pop()! + suffix;
      }
    }
    return [parts.join(""), args, suffix];
  },

  // Lua: text_ir.lua:628
  toAscii(ir: Seg[] | undefined | null, ctx?: any): string {
    const parts: string[] = [];
    for (const seg of ir ?? []) {
      const t = seg.t;
      if (t === "eos") {
        break;
      } else if (own(ASCII_BREAK, t) !== undefined) {
        parts.push(ASCII_BREAK[t]!);
      } else if (t !== "ext") {
        const value = expand_seg(seg, ctx);
        if (value != null) parts.push(tostring(value));
      }
    }
    return parts.join("").replace(/\\p\n+$/, "\\p");
  },

  /**
   * Expand IR to printable pages for host textbox. Yields on scroll/para;
   * caller advances. stringVars/player/rival from ctx.
   * Indices are 0-based here (the Lua's 1 is 0): returns [page, next, kind].
   */
  // Lua: text_ir.lua:646
  expandPage(ir: Seg[], startIdx?: number, ctx?: any): [string, number, string] {
    const parts: string[] = [];
    let i = startIdx ?? 0;
    while (i < ir.length) {
      const seg = ir[i]!;
      const t = seg.t;
      if (t === "nl") {
        parts.push("\n");
      } else if (t === "para" || t === "scroll") {
        return [parts.join(""), i + 1, t];
      } else if (t === "eos") {
        return [parts.join(""), i + 1, "eos"];
      } else if (t === "ext") {
        // ignore for v1 printer
      } else {
        const s = expand_seg(seg, ctx);
        if (truthy(s)) parts.push(tostring(s));
      }
      i = i + 1;
    }
    return [parts.join(""), i, "eos"];
  },

  // Lua: text_ir.lua:669
  toPlain(ir: Seg[], ctx?: any): string {
    const pages: string[] = [];
    let idx = 0;
    let kind: string | undefined;
    do {
      let page: string;
      [page, idx, kind] = TextIR.expandPage(ir, idx, ctx);
      if (page && page.length > 0) pages.push(page);
    } while (!(kind === "eos" || !kind));
    return pages.join("\n\n");
  },

  /**
   * Host TextBox string: always tap-per-page of at most two lines.
   * `\n` joins the pair inside a page; `\f` clears for the next pair (wait A).
   * Never emits `\v` CONT scroll — Gen1 column budgets make one-line scroll feel
   * too fast. GBA `\p` / `\l` both force a page boundary like a filled pair.
   */
  // Lua: text_ir.lua:739
  toTextBox(ir: Seg[] | undefined | null, ctx?: any): string {
    const mw = ctx !== null && typeof ctx === "object" ? ctx.maxWidth : undefined;
    const maxW: number = truthy(mw) ? mw : 208;
    const lines: { s: string; hard: boolean }[] = [];
    let buf: string[] = [];
    const flush = (hard: boolean): void => {
      lines.push({ s: buf.join(""), hard });
      buf = [];
    };
    for (const seg of ir ?? []) {
      const t = seg.t;
      const expanded = expand_seg(seg, ctx);
      if (expanded != null) {
        buf.push(tostring(expanded));
      } else if (t === "nl") {
        flush(false);
      } else if (t === "para" || t === "scroll") {
        flush(true);
      } else if (t === "eos") {
        if (buf.length > 0) flush(false);
      }
    }
    if (buf.length > 0) flush(false);

    const splitLines: { s: string; hard: boolean }[] = [];
    for (const row of lines) {
      const text = TextIR.protectExt(row.s);
      const hard = row.hard;
      let subl: string[] = [];
      for (const m of (text + "\n").matchAll(/([\s\S]*?)\r?\n/g)) {
        subl.push(m[1]!);
      }
      if (subl.length === 0) subl = [""];
      for (let si = 0; si < subl.length; si++) {
        const isLastSub = si === subl.length - 1;
        const wrappedList = wrap_subline(subl[si]!, maxW);
        for (let wi = 0; wi < wrappedList.length; wi++) {
          const isLastWrap = wi === wrappedList.length - 1;
          splitLines.push({
            s: wrappedList[wi]!,
            hard: (isLastSub && isLastWrap) ? hard : false,
          });
        }
      }
    }

    const parts: string[] = [];
    let onPage = 0;
    for (const row of splitLines) {
      if (row.s !== "" || row.hard) {
        if (onPage >= 2) {
          if (parts.length > 0) parts.push("\f");
          onPage = 0;
        } else if (onPage > 0) {
          parts.push("\n");
        }
        if (row.s !== "") {
          parts.push(row.s);
          onPage = onPage + 1;
        }
        if (row.hard) {
          onPage = 2; // next line starts a fresh cleared page
        }
      }
    }
    const s = parts.join("").replace(/^\f+/, "").replace(/\f+$/, "");
    return TextIR.restoreExt(s);
  },
};

export default TextIR;
