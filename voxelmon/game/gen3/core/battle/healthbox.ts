// Port of gen1recomp src/core/game3/battle/healthbox.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG battler healthboxes via pret OAM semantics + interface element tiles.
// CreateSprite centers; HP bar subsprites are offsets from that center
// (AddSubspritesToOamBuffer undoes centerToCorner, then applies subsprite x/y).
//
// Healthbox GFX bake placeholder "Lv" / "/" tiles; pret TextIntoHealthboxObject
// overwrites them. We cream-fill those regions and print like UpdateNick /
// UpdateLvl / UpdateHpTextInHealthbox.
//
// Port notes:
// - CENTERS is keyed "false" / "true" (Lua's [false] / [true]).
// - pcall(require, "src.core.game3.battle.anim") followed by a call: while
//   the anim engine is a stub, its NotPortedError is Brian's failed-require
//   path (viaAnim). Plain requires call straight in.
// - package.loaded["src.core.game3.battle"] is the Battle module (battle.ts);
//   pcall(require) of runtime / field: linked in.
// - The weak-keyed small_opts cache is a WeakMap.
// - The LEVEL_UP shader is the `level_flash` effect; vector sends are plain
//   arrays.
// - Multiple returns: hp_values / display_hp_nums / safari_balls_text return
//   tuples.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { format, tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { seq, len, ipairs, type LuaTable } from "../../platform/lt.ts";
import { G, type Shader } from "../../platform/graphics.ts";
import type { Image, Quad } from "../../platform/image.ts";
import { NotPortedError } from "../../notported.ts";
import BattleChrome from "../../ui/battle_chrome.ts";
import FrlgFont from "../../ui/frlg_font.ts";
import SummaryChrome from "../../ui/summary_chrome.ts";
import State from "./state.ts";
import RomText from "../rom_text.ts";
import Anim from "./anim.ts";
import Pokemon from "../pokemon.ts";
import SummaryData from "../summary_data.ts";
import BattleProfile from "./profile.ts";
import Experience from "./experience.ts";
import Dex from "../dex.ts";
import Runtime from "../runtime.ts";
import Field from "../field.ts";
import { Battle } from "../battle.ts";

interface XY { x: number; y: number }

export interface HealthboxModule {
  ENEMY_CENTER: XY;
  PLAYER_CENTER: XY;
  CENTERS: Record<string, Record<number, XY>>;
  center(st: any, id: any): XY;
  hpTextShown(st: any, id: any): boolean;
  swapHpBarsWithHpText(st: any): void;
  draw(side: any, battler: any, opts?: any): void;
  shouldShowCaughtMarker(st: any, battler: any): boolean;
  syncOam(st?: any): void;
}

export const Healthbox = {} as HealthboxModule;

/** pcall(require, anim) + a call: a stubbed anim engine is the failed require. */
function viaAnim<T>(f: () => T): [boolean, T | undefined] {
  try {
    return [true, f()];
  } catch (e) {
    if (e instanceof NotPortedError) return [false, undefined];
    throw e;
  }
}

// pret InitBattlerHealthboxCoords (singles) — sprite CENTER of left half
Healthbox.ENEMY_CENTER = { x: 44, y: 30 };
Healthbox.PLAYER_CENTER = { x: 158, y: 88 };

// pokefirered/src/battle_interface.c:726
Healthbox.CENTERS = {
  false: { [0]: Healthbox.PLAYER_CENTER, [1]: Healthbox.ENEMY_CENTER },
  true: {
    [0]: { x: 159, y: 75 },
    [1]: { x: 44, y: 19 },
    [2]: { x: 171, y: 100 },
    [3]: { x: 32, y: 44 },
  },
};

// Lua: healthbox.lua:31
Healthbox.center = function (st: any, id: any): XY {
  const n: number = tonumber(id) ?? 0;
  const t = Healthbox.CENTERS[(truthy(st) && truthy(st.double)) ? "true" : "false"]!;
  return t[n] ?? t[((n % 2) + 2) % 2]!;
};

/** A colour as a Lua sequence {r, g, b, a} (what G.setColor / FrlgFont take). */
function col(...v: number[]): number[] {
  return seq(...v) as number[];
}

// Lua: healthbox.lua:37
function c5(v: number): number {
  return Math.floor(v * 255 / 31 + 0.5) / 255;
}

// Cream fill matches healthbox pal index 2 (text bg).
// pokefirered/src/battle_interface.c:2204
const CREAM = col(c5(31), c5(31), c5(27), 1);

// Healthbox OBJ pal text colors (gBattleInterface_Healthbox_Pal).
// Nick: fg=1 shadow=3; gender uses DYNAMIC_COLOR_2/1 (pal 11 / 10).
const HB_TEXT = {
  fg: col(c5(8), c5(8), c5(8), 1),
  shadow: col(c5(27), c5(26), c5(22), 1),
};
const HB_MALE = {
  fg: col(65 / 255, 205 / 255, 255 / 255, 1),
  shadow: col(0 / 255, 98 / 255, 148 / 255, 1),
};
const HB_FEMALE = {
  fg: col(255 / 255, 156 / 255, 148 / 255, 1),
  shadow: col(156 / 255, 65 / 255, 57 / 255, 1),
};

// pokefirered/src/battle_interface.c:773
const PLAYER_LVL_X = 72;
const ENEMY_LVL_X = 64;

// pret AddTextPrinterAndCreateWindowOnHealthbox(..., y=3) for nick / level.
const TEXT_Y = 3;
// pokefirered/src/battle_interface.c:813
const HP_TEXT_Y = 21;
const HP_CUR_X = 60;
const HP_MAX_X = 80;
// pokefirered/src/battle_interface.c:2221
const HP_WIN_X = 56, HP_WIN_W = 40, HP_WIN_H = 11;

// Baked placeholder ink + drop-shadow on healthbox sheets.
// Shadow is pal index 3 ≈ (222,214,181). Do NOT rectangle-fill (eats top border).
const PLAYER_PLACEHOLDER_INK = seq(
  // "Lv" fg (66,66,66)
  seq(64, 10), seq(64, 11), seq(68, 11), seq(70, 11),
  seq(64, 12), seq(68, 12), seq(70, 12),
  seq(64, 13), seq(68, 13), seq(70, 13),
  seq(64, 14), seq(65, 14), seq(66, 14), seq(67, 14), seq(69, 14),
  // "Lv" shadow
  seq(65, 11), seq(71, 11), seq(65, 12), seq(71, 12), seq(65, 13), seq(71, 13),
  seq(68, 14), seq(70, 14), seq(71, 14),
  seq(64, 15), seq(65, 15), seq(66, 15), seq(67, 15), seq(68, 15), seq(69, 15), seq(70, 15),
);

const ENEMY_PLACEHOLDER_INK = seq(
  // "Lv" fg
  seq(56, 10), seq(56, 11), seq(60, 11), seq(62, 11),
  seq(56, 12), seq(60, 12), seq(62, 12),
  seq(56, 13), seq(60, 13), seq(62, 13),
  seq(56, 14), seq(57, 14), seq(58, 14), seq(59, 14), seq(61, 14),
  // "Lv" shadow
  seq(57, 11), seq(63, 11), seq(57, 12), seq(63, 12), seq(57, 13), seq(63, 13),
  seq(60, 14), seq(62, 14), seq(63, 14),
  seq(56, 15), seq(57, 15), seq(58, 15), seq(59, 15), seq(60, 15), seq(61, 15), seq(62, 15),
);

// Lua: healthbox.lua:99
function player_top_left(cx: number, cy: number): [number, number] {
  return [cx - 32, cy - 16];
}

// Lua: healthbox.lua:103
function enemy_top_left(cx: number, cy: number): [number, number] {
  return [cx - 32, cy - 16];
}

/** HP bar sprite center (SpriteCB_HealthBar). */
// Lua: healthbox.lua:108
function hp_bar_center(side: any, hbCx: number, hbCy: number): [number, number] {
  if (side === "player") {
    return [hbCx + 16, hbCy];
  }
  return [hbCx + 8, hbCy];
}

/** Subsprite 0 is at (−16, 0) from center → composite TL = (cx−16, cy). */
// Lua: healthbox.lua:116
function hp_bar_top_left(barCx: number, barCy: number): [number, number] {
  return [barCx - 16, barCy];
}

// Lua: healthbox.lua:120
function hp_values(side: any, battler: any): [number, number] {
  // pcall(require, "src.core.game3.battle.anim")
  if (truthy(Anim) && truthy(Anim.displayHpRatio)) {
    const [ok, r] = viaAnim(() => Anim.displayHpRatio(side, battler));
    if (ok) {
      const hp = r[1], maxHp = r[2];
      return [tonumber(hp) ?? 0, tonumber(maxHp) ?? 1];
    }
  }
  const mon = truthy(battler) ? battler.mon : undefined;
  const hp = tonumber(truthy(mon) ? mon.hp : undefined) ?? 0;
  let maxHp = tonumber(truthy(mon) ? mon.maxHp : undefined) ?? 1;
  if (maxHp < 1) maxHp = 1;
  return [hp, maxHp];
}

// pokefirered/src/battle_interface.c:2050
// Lua: healthbox.lua:134
function display_hp_nums(side: any, battler: any): [number, number] {
  const [hp, maxHp] = hp_values(side, battler);
  return [Math.floor(hp), Math.floor(maxHp)];
}

// One read-only FrlgFont opts table per colour set (FrlgFont never writes
// to opts), so per-frame healthbox text does not allocate.
const _smallOpts = new WeakMap<object, any>();
// Lua: healthbox.lua:142
function small_opts(colors?: object): any {
  colors = colors ?? HB_TEXT;
  let o = _smallOpts.get(colors);
  if (!o) {
    o = { small: true, colors };
    _smallOpts.set(colors, o);
  }
  return o;
}

// Lua: healthbox.lua:152
function erase_placeholder_ink(boxX: number, boxY: number, pts: LuaTable): void {
  G.setColor(CREAM);
  for (let i = 1; i <= len(pts); i++) {
    const p = pts[i];
    G.rectangle("fill", boxX + p[1], boxY + p[2], 1, 1);
  }
  G.setColor(1, 1, 1, 1);
}

/** Pret UpdateNickInHealthbox: hide gender when nick == species for Nidoran. */
// Lua: healthbox.lua:162
function healthbox_gender(mon: any): string | undefined {
  if (!truthy(mon)) return undefined;
  let g = mon.gender;
  if (g !== "M" && g !== "F") {
    const species = tonumber(truthy(mon.species) ? mon.species : mon.speciesId);
    if (species != null && truthy(Pokemon.gender)) {
      g = Pokemon.gender(species, mon.personality);
    }
  }
  if (g !== "M" && g !== "F") return undefined;
  const species = tonumber(truthy(mon.species) ? mon.species : mon.speciesId) ?? 0;
  // SPECIES_NIDORAN_F=29, SPECIES_NIDORAN_M=32 (FRLG national)
  if (species === 29 || species === 32) {
    const nick = tostring(truthy(mon.nickname) ? mon.nickname : "");
    const sname = tostring(truthy(mon.name) ? mon.name : "");
    if (nick === "" || nick === sname) {
      return undefined;
    }
  }
  return g;
}

const MEASURE_SMALL = { small: true };

// Lua: healthbox.lua:185
function draw_name_gender(name: string, gender: string | undefined, x: number, y: number): void {
  FrlgFont.draw(name, x, y, small_opts(HB_TEXT));
  if (!gender) return;
  const nw = FrlgFont.measure(name, MEASURE_SMALL);
  // ♂/♀ join arrow↔circle mostly via shadow pixels; need HB shadow on cream
  // (FrlgFont.COLOR.MALE shadow is nearly invisible here and splits the glyph).
  if (gender === "M") {
    FrlgFont.drawGlyph(FrlgFont.CHAR_MALE, x + nw, y, small_opts(HB_MALE));
  } else if (gender === "F") {
    FrlgFont.drawGlyph(FrlgFont.CHAR_FEMALE, x + nw, y, small_opts(HB_FEMALE));
  }
}

// pokefirered/src/battle_interface.c:759
// Lua: healthbox.lua:199
function draw_level(lv: any, boxX: number, y: number, winX: number): void {
  const digits = tostring(Math.max(0, Math.min(999, Math.floor(tonumber(lv) ?? 1))));
  const lvW = FrlgFont.advance(FrlgFont.CHAR_LV_2, MEASURE_SMALL);
  const x = boxX + winX + 5 * (3 - digits.length);
  FrlgFont.drawGlyph(FrlgFont.CHAR_LV_2, x, y, small_opts(HB_TEXT));
  FrlgFont.draw(digits, x + lvW, y, small_opts(HB_TEXT));
}

// Lua: healthbox.lua:207
function erase_hp_window(boxX: number, boxY: number): void {
  G.setColor(CREAM);
  G.rectangle("fill", boxX + HP_WIN_X, boxY + HP_TEXT_Y, HP_WIN_W, HP_WIN_H);
  G.setColor(1, 1, 1, 1);
}

// pokefirered/src/battle_interface.c:615
const SAFARI_CAP_X = 96, SAFARI_CAP_Y = 17, SAFARI_CAP_W = 2, SAFARI_CAP_H = 7;
const SAFARI_STRIP_X = 18, SAFARI_STRIP_Y = 34, SAFARI_STRIP_W = 78, SAFARI_STRIP_H = 4;
const BOX_SHADOW_SRC_X = 10, BOX_SHADOW_SRC_Y = 35;
let _shadowImg: Image | undefined, _shadowQuad: Quad | undefined;
let _ballsText: string | undefined, _ballsCount: number | undefined, _ballsW = 0;

// Lua: healthbox.lua:220
function draw_safari_box(boxX: number, boxY: number): void {
  G.setColor(CREAM);
  G.rectangle("fill", boxX + SAFARI_CAP_X, boxY + SAFARI_CAP_Y, SAFARI_CAP_W, SAFARI_CAP_H);
  G.setColor(1, 1, 1, 1);
  const img = BattleChrome._playerBox;
  if (!img) return;
  if (_shadowImg !== img) {
    _shadowImg = img;
    const [iw, ih] = img.getDimensions();
    _shadowQuad = G.newQuad(BOX_SHADOW_SRC_X, BOX_SHADOW_SRC_Y, 1, 1, iw, ih);
  }
  G.draw(img, _shadowQuad, boxX + SAFARI_STRIP_X, boxY + SAFARI_STRIP_Y, 0,
    SAFARI_STRIP_W, SAFARI_STRIP_H);
}

// pokefirered/src/battle_interface.c:1743
// Lua: healthbox.lua:235
function safari_balls_text(balls: number): [string, number] {
  if (_ballsCount !== balls || !_ballsText) {
    _ballsCount = balls;
    const key = BattleProfile.get(undefined).strings.safariBallsLeft;
    _ballsText = RomText.plain(key) + tostring(balls);
    _ballsW = FrlgFont.measure(_ballsText, MEASURE_SMALL);
  }
  return [_ballsText, _ballsW];
}

// pokefirered/src/battle_interface.c:795
// Lua: healthbox.lua:246
function draw_hp_nums(cur: any, maxHp: any, boxX: number, boxY: number): void {
  FrlgFont.draw(format("%3d/", cur ?? 0), boxX + HP_CUR_X, boxY + HP_TEXT_Y, small_opts(HB_TEXT));
  FrlgFont.draw(format("%3d", maxHp ?? 0), boxX + HP_MAX_X, boxY + HP_TEXT_Y, small_opts(HB_TEXT));
}

// Lua: healthbox.lua:251 (LEVEL_UP_SRC): the level_flash effect.
const LEVEL_UP_SRC = "level_flash";
let levelUpShader: Shader | false | undefined;
// pokefirered/graphics/battle_interface/healthbox.pal
const HB_PAL: Record<number, number[][]> = {
  [2]: [[255, 255, 222], [222, 213, 180]],
  [6]: [[82, 106, 98], [32, 57, 0]],
};

// pokefirered/src/battle_anim_special.c:569
// Lua: healthbox.lua:270
function set_level_up_shader(blend: any): boolean {
  if (!(truthy(blend) && (tonumber(blend.coeff) ?? 0) > 0)) return false;
  if (levelUpShader === undefined) {
    try { levelUpShader = G.newShader(LEVEL_UP_SRC); } catch { levelUpShader = false; }
  }
  if (!levelUpShader) return false;
  const sh = levelUpShader;
  const keys = HB_PAL[truthy(blend.colorIndex) ? blend.colorIndex : 6] ?? HB_PAL[6]!;
  const col: number = tonumber(blend.color) ?? 0;
  let ok = true;
  try {
    sh.send("k1", [keys[0]![0]! / 255, keys[0]![1]! / 255, keys[0]![2]! / 255]);
    sh.send("k2", [keys[1]![0]! / 255, keys[1]![1]! / 255, keys[1]![2]! / 255]);
    sh.send("target", [(col % 32) / 31, (Math.floor(col / 32) % 32) / 31, (Math.floor(col / 1024) % 32) / 31]);
    sh.send("coeff", Math.min(1, blend.coeff / 16));
  } catch {
    ok = false;
  }
  if (!ok) return false;
  G.setShader(sh);
  return true;
}

// Lua: healthbox.lua:290
function live_st(): any {
  // package.loaded["src.core.game3.battle"]
  return truthy(Battle) ? Battle._st : undefined;
}

// Lua: healthbox.lua:295
function anim_key(id: any): any {
  if (id === 0) return "player"; else if (id === 1) return "enemy";
  return id;
}

// Lua: healthbox.lua:300
function stage_entry(tbl: any, id: any): any {
  if (tbl === null || typeof tbl !== "object") return undefined;
  let e = tbl[id];
  if (e == null) e = tbl[anim_key(id)];
  return e;
}

// pokefirered/src/battle_interface.c:992
// Lua: healthbox.lua:308
Healthbox.hpTextShown = function (st: any, id: any): boolean {
  return (truthy(st) && truthy(st.double) && truthy(st._hpNumbersNoBars) && truthy(st._hpNumbersNoBars[id])) ? true : false;
};

// pokefirered/src/battle_interface.c:992
// Lua: healthbox.lua:313
Healthbox.swapHpBarsWithHpText = function (st: any): void {
  if (!(truthy(st) && truthy(st.double))) return;
  st._hpNumbersNoBars = st._hpNumbersNoBars ?? {};
  for (const [, id] of ipairs<number>(SWAP_IDS)) {
    if (truthy(st.battlers) && truthy(st.battlers[id])) {
      st._hpNumbersNoBars[id] = !truthy(st._hpNumbersNoBars[id]);
    }
  }
};
// ipairs({ 0, 2 })
const SWAP_IDS = seq(0, 2);

const BAR_FG = col(c5(7), c5(7), c5(7), 1);
const BAR_SHADOW = col(c5(26), c5(25), c5(23), 1);
const BOTTOM_RIGHT_CORNER_HP_AS_TEXT = 116;

// pokefirered/src/battle_interface.c:864
// Lua: healthbox.lua:328
function draw_hp_text_doubles(bx: number, by: number, cur: any, maxHp: any): void {
  const opts = { small: true, colors: { fg: BAR_FG, shadow: BAR_SHADOW, bg: undefined } };
  const left = format("%3d/", Math.max(0, Math.min(999, Math.floor(cur ?? 0))));
  const right = format("%3d", Math.max(0, Math.min(999, Math.floor(maxHp ?? 0))));
  if (BattleChrome.hasHpBoldDigits()) {
    for (let i = 1; i <= 4; i++) {
      const ch = left.charAt(i - 1);
      if (ch !== " ") BattleChrome.drawHpBoldChar(ch, bx + 8 * i, by);
    }
    for (let i = 1; i <= 3; i++) {
      const ch = right.charAt(i - 1);
      if (ch !== " ") BattleChrome.drawHpBoldChar(ch, bx + 32 + 8 * i, by);
    }
    return;
  }
  // pokefirered/src/text.c:1268
  const ty = by - 3;
  for (let i = 1; i <= 4; i++) {
    const ch = left.charAt(i - 1);
    if (ch !== " ") FrlgFont.draw(ch, bx + 8 * i, ty, opts);
  }
  for (let i = 1; i <= 3; i++) {
    const ch = right.charAt(i - 1);
    if (ch !== " ") FrlgFont.draw(ch, bx + 32 + 8 * i, ty, opts);
  }
}

// Lua: healthbox.lua:355
function draw_doubles(id: number, battler: any, st: any, opts: any): void {
  const stage = truthy(Anim.stage) ? Anim.stage() : undefined;
  const hb = truthy(stage) ? stage_entry(stage.healthbox, id) : undefined;
  if (truthy(hb) && hb.visible === false) return;
  const ox = ((truthy(hb) && hb.ox) || 0) + ((truthy(opts) && opts.ox) || 0);
  const oy = ((truthy(hb) && hb.oy) || 0) + ((truthy(opts) && opts.oy) || 0);
  const isPlayer = (id % 2) === 0;
  const c = Healthbox.center(st, id);
  const cx = c.x + ox, cy = c.y + oy;
  const tlX = cx - 32, tlY = cy - 16;

  const lvl = isPlayer && set_level_up_shader(truthy(hb) ? hb.levelUpBlend : undefined);
  BattleChrome.drawDoublesBox(isPlayer, tlX, tlY);
  if (lvl) G.setShader();
  erase_placeholder_ink(tlX, tlY, isPlayer ? PLAYER_PLACEHOLDER_INK : ENEMY_PLACEHOLDER_INK);

  const stObj = status_obj(battler);
  const ailment = SummaryData.statusAilment({ status: stObj, hp: truthy(battler.mon) ? battler.mon.hp : undefined });
  const statused = ailment >= 1 && ailment <= 6;
  const hpText = isPlayer && Healthbox.hpTextShown(st, id);

  const barCx = cx + (isPlayer ? 16 : 8);
  const [bx, by] = hp_bar_top_left(barCx, cy);
  const [hp, maxHp] = hp_values(id, battler);
  if (hpText) {
    draw_hp_text_doubles(bx, by, hp, maxHp);
    // pokefirered/src/battle_interface.c:925
    BattleChrome.drawElementTile(BOTTOM_RIGHT_CORNER_HP_AS_TEXT, tlX + 96, tlY + 16, true);
  } else {
    BattleChrome.drawHpBar(bx, by, hp, maxHp, statused);
  }

  const name = State.displayName(battler);
  let lv = (truthy(battler.mon) && battler.mon.level) || 1;
  const p = truthy(Anim.present) ? Anim.present(id) : undefined;
  if (truthy(p) && truthy(p.displayLevel)) lv = p.displayLevel;
  const ty = tlY + TEXT_Y;
  const gender = healthbox_gender(battler.mon);
  // pokefirered/src/battle_interface.c:1531
  draw_name_gender(name, gender, tlX + (isPlayer ? 16 : 8), ty);
  draw_level(lv, tlX, ty, isPlayer ? PLAYER_LVL_X : ENEMY_LVL_X);
  if (statused) {
    // pokefirered/src/battle_interface.c:1608
    SummaryChrome.drawStatusIcon(tlX + (isPlayer ? 10 : 2), tlY + 16, ailment);
  }
}

/** `battler.status or (battler.mon and (battler.mon.status or battler.mon.status1))` */
function status_obj(battler: any): any {
  if (truthy(battler.status)) return battler.status;
  const mon = battler.mon;
  if (!truthy(mon)) return mon;
  return truthy(mon.status) ? mon.status : mon.status1;
}

// Lua: healthbox.lua:405
Healthbox.draw = function (side: any, battler: any, opts?: any): void {
  if (!truthy(battler)) return;
  if (typeof side === "number") {
    const st = (truthy(opts) && truthy(opts.st)) ? opts.st : live_st();
    if (truthy(st) && truthy(st.double)) {
      return draw_doubles(side, battler, st, opts);
    }
    side = (side % 2 === 0) ? "player" : "enemy";
  }
  const stage = truthy(Anim.stage) ? Anim.stage() : undefined;
  const hb = truthy(stage) && truthy(stage.healthbox) ? stage.healthbox[side] : undefined;
  if (truthy(hb) && hb.visible === false) return;
  const ox = ((truthy(hb) && hb.ox) || 0) + ((truthy(opts) && opts.ox) || 0);
  const oy = (truthy(opts) && opts.oy) || 0;

  const isPlayer = side === "player";
  const c0 = isPlayer ? Healthbox.PLAYER_CENTER : Healthbox.ENEMY_CENTER;
  const c = { x: c0.x, y: c0.y + oy };
  let tlX: number, tlY: number;
  if (isPlayer) {
    [tlX, tlY] = player_top_left(c.x + ox, c.y);
    const lvl = set_level_up_shader(truthy(hb) ? hb.levelUpBlend : undefined);
    BattleChrome.drawPlayerBox(tlX, tlY);
    if (lvl) G.setShader();
    erase_placeholder_ink(tlX, tlY, PLAYER_PLACEHOLDER_INK);
    erase_hp_window(tlX, tlY);
  } else {
    [tlX, tlY] = enemy_top_left(c.x + ox, c.y);
    BattleChrome.drawEnemyBox(tlX, tlY);
    erase_placeholder_ink(tlX, tlY, ENEMY_PLACEHOLDER_INK);
  }

  const bstSafari = live_st();
  if (isPlayer && truthy(bstSafari) && truthy(bstSafari.safari)) {
    // pokefirered/src/battle_interface.c:1743
    const balls = (truthy(bstSafari.safariState) ? tonumber(bstSafari.safariState.balls) : undefined) ?? 0;
    const [hcx, hcy] = hp_bar_center(side, c.x + ox, c.y);
    const [sbx, sby] = hp_bar_top_left(hcx, hcy);
    G.setColor(CREAM);
    G.rectangle("fill", sbx, sby - 2, 64, 10);
    G.setColor(1, 1, 1, 1);
    draw_safari_box(tlX, tlY);
    FrlgFont.draw(RomText.plain("gText_SafariBalls"), tlX + 16, tlY + TEXT_Y, small_opts(HB_TEXT));
    const [left, w] = safari_balls_text(Math.max(0, Math.floor(balls)));
    FrlgFont.draw(left, tlX + HP_WIN_X + HP_WIN_W - w, tlY + HP_TEXT_Y, small_opts(HB_TEXT));
    return;
  }

  const [barCx, barCy] = hp_bar_center(side, c.x + ox, c.y);
  const [bx, by] = hp_bar_top_left(barCx, barCy);
  let statusBorder = false;
  if (!isPlayer) {
    const st1 = status_obj(battler);
    const a = SummaryData.statusAilment({ status: st1, hp: truthy(battler.mon) ? battler.mon.hp : undefined });
    // pokefirered/src/battle_interface.c:1668
    statusBorder = a >= 1 && a <= 6;
  }
  const [hpNow, hpMax] = hp_values(side, battler);
  BattleChrome.drawHpBar(bx, by, hpNow, hpMax, statusBorder);

  let name: string = State.displayName(battler);
  let lv = (truthy(battler.mon) && battler.mon.level) || 1;
  {
    // pcall(require, "src.core.game3.battle.anim")
    if (truthy(Anim) && truthy(Anim.present)) {
      const [ok, p] = viaAnim(() => Anim.present(side));
      if (ok && truthy(p) && truthy(p.displayLevel)) lv = p.displayLevel;
    }
  }

  const ty = tlY + TEXT_Y;
  const lvlX = isPlayer ? PLAYER_LVL_X : ENEMY_LVL_X;
  let gender = healthbox_gender(battler.mon);
  // pokefirered/src/battle_interface.c:1506
  const bst = live_st();
  if (!isPlayer && truthy(bst) && truthy(bst.ghostBattle) && name === RomText.plain("gText_Ghost")) {
    const [okA, pg] = viaAnim(() => (truthy(Anim.present) ? Anim.present("enemy") : undefined));
    if (okA && truthy(pg) && truthy(pg.ghostUnveiled)) {
      // pokefirered/src/battle_gfx_sfx_util.c:686
      name = Pokemon.name(battler.species) ?? name;
    } else {
      gender = undefined;
    }
  }

  const stObj = status_obj(battler);
  const ailment = SummaryData.statusAilment({ status: stObj, hp: truthy(battler.mon) ? battler.mon.hp : undefined });

  if (isPlayer) {
    draw_name_gender(name, gender, tlX + 16, ty);
    draw_level(lv, tlX, ty, lvlX);
    if (ailment >= 1 && ailment <= 6) {
      // pokefirered/src/battle_interface.c:1608
      SummaryChrome.drawStatusIcon(tlX + 10, tlY + 24, ailment);
    }
    const mon = battler.mon;
    if (truthy(mon)) {
      const [cur, maxHp] = display_hp_nums(side, battler);
      draw_hp_nums(cur, maxHp, tlX, tlY);
    }
    let expRatio = 0;
    {
      // pcall(require, "src.core.game3.battle.anim")
      let ok = false;
      if (truthy(Anim) && truthy(Anim.displayExpRatio)) {
        const [okE, r] = viaAnim(() => Anim.displayExpRatio(side, battler));
        if (okE) { ok = true; expRatio = r; }
      }
      if (!ok) {
        const prog = Experience.progress(battler.mon);
        expRatio = prog.progressPercent ?? 0;
      }
    }
    BattleChrome.drawExpBar(tlX + 32, tlY + 32, expRatio);
  } else {
    draw_name_gender(name, gender, tlX + 8, ty);
    draw_level(lv, tlX, ty, lvlX);
    if (ailment >= 1 && ailment <= 6) {
      // pokefirered/src/battle_interface.c:1614
      SummaryChrome.drawStatusIcon(tlX + 2, tlY + 16, ailment);
    } else {
      // pokefirered/src/battle_interface.c:1658
      const species = truthy(battler.species) ? battler.species
        : (truthy(battler.mon) ? (truthy(battler.mon.species) ? battler.mon.species : battler.mon.speciesId) : battler.mon);
      let latch = battler._caughtIcon;
      if (!truthy(latch) || latch.mon !== battler.mon || latch.species !== species || latch.ailment !== ailment
          || latch.name !== name) {
        latch = {
          mon: battler.mon, species, ailment, name,
          show: Healthbox.shouldShowCaughtMarker(bst, battler),
        };
        battler._caughtIcon = latch;
      }
      if (latch.show) {
        BattleChrome.drawPartyBall(tlX + 8, tlY + 16, "caught");
      }
    }
  }
};

// Lua: healthbox.lua:546
Healthbox.shouldShowCaughtMarker = function (st: any, battler: any): boolean {
  if (!truthy(battler)) return false;
  if (truthy(battler.isPlayer) || battler.side === "player") return false;

  // Must not be first battle / tutorial / pokedude
  if (truthy(st) && (truthy(st.firstBattle) || truthy(st.oldManTutorial) || truthy(st.pokedude))) {
    return false;
  }

  // Must not be trainer battle (wild only, matching pokefirered BATTLE_TYPE_TRAINER check)
  if (truthy(st) && (truthy(st.trainer) || truthy(st.trainerId) || truthy(st.isTrainerBattle) || st.kind === "trainer")) {
    return false;
  }
  if (truthy(battler.isTrainer) || truthy(battler.trainer)) {
    return false;
  }

  // Ghost battles: un-identified ghosts (name == "GHOST") do not show caught ball
  if (truthy(st) && truthy(st.ghostBattle) && !truthy(st.ghostUnveiled)) {
    return false;
  }
  const name = State.displayName(battler);
  if (RomText.has("gText_Ghost") && name === RomText.plain("gText_Ghost")) {
    return false;
  }

  const species = truthy(battler.species) ? battler.species
    : (truthy(battler.mon) ? (truthy(battler.mon.species) ? battler.mon.species : battler.mon.speciesId) : battler.mon);
  if (!truthy(species) || species === 0) return false;

  let dex = truthy(st) ? (truthy(st.dex) ? st.dex : (truthy(st.session) ? st.session.dex : st.session)) : st;
  if (!truthy(dex)) {
    // package.loaded["src.core.game3.battle"]
    const bst = truthy(Battle) ? Battle._st : undefined;
    dex = truthy(bst) ? (truthy(bst.dex) ? bst.dex : (truthy(bst.session) ? bst.session.dex : bst.session)) : bst;
  }
  if (!truthy(dex)) {
    // pcall(require, "src.core.game3.runtime")
    if (truthy(Runtime) && truthy(Runtime.getSession)) {
      const s = Runtime.getSession();
      dex = truthy(s) ? s.dex : s;
    }
  }
  if (!truthy(dex)) {
    // pcall(require, "src.core.game3.field")
    if (truthy(Field) && truthy(Field._session)) {
      dex = Field._session.dex;
    }
  }
  if (!truthy(dex)) return false;

  return Dex.isCaught(dex, species) === true;
};

// Lua: healthbox.lua:600
Healthbox.syncOam = function (_st?: any): void {
  return;
};

export default Healthbox;
