// Port of gen1recomp src/ui/game3/naming.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG naming screen as a reusable Stack modal (pret naming_screen.c).
// Keyboard letters sit on pret sPageColumnXPos cells; cursor uses CreateSprite centers.
// Player icon is field OW (Red/Leaf), same as NamingScreen_CreatePlayerIcon.
// Preset name lists stay in Oak; this modal is keyboard-only.
//
// Strings are byte strings: the keyboard's non-ASCII keys are the UTF-8 bytes
// of Brian's literals (♂ = "\xE2\x99\x82"). The Lua interleaves Naming.*
// functions with locals; every function here sits in the Lua's order and the
// Naming table is assembled at the end of the file.

import { Display } from "../core/display.ts";
import { FrlgFont } from "./frlg_font.ts";
import { Chrome } from "./chrome.ts";
import { Stack } from "./stack.ts";
import { Audio } from "../core/audio.ts";
import { NamingChrome } from "./naming_chrome.ts";
import { OwSprites } from "../core/ow_sprites.ts";
import { Versions } from "../../../import/gen3/versions.ts";
import { RomText } from "../core/rom_text.ts";
import { TextIR } from "../core/scripting/text_ir.ts";
import { Message } from "./message.ts";
import { Runtime } from "../core/runtime.ts";
import { CatchSeq } from "../core/battle/catch_seq.ts";
import { Storage } from "../core/storage.ts";
import { Pokemon } from "../core/pokemon.ts";
import { Fade } from "./fade.ts";
import { PokedexChrome } from "./pokedex_chrome.ts";
import { mod, sub, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { gmatch, gsub, match } from "../platform/lpattern.ts";
import { fromArray, ipairs, len, seq } from "../platform/lt.ts";
import { G } from "../platform/graphics.ts";
import { Fs } from "../platform/fs.ts";
import { newImageData, type Image, type ImageData, type Quad } from "../platform/image.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** One keyboard page: rows and colX are 1-based sequences. */
interface Page { id: string; rows: any; colX: any }

/** The modal's state table (Naming.open / Naming.begin). */
export interface NamingState {
  title: any;
  maxLen: number;
  name: string;
  seed: any;
  page: number;
  row: number;
  col: number;
  btn: number;
  blink: number;
  swapT?: number | null;
  swapTo?: number | null;
  icon?: any;
  gender?: any;
  template?: string;
  species?: any;
  personality?: any;
  onDone?: ((result: any) => void) | null;
  hold?: any;
  session?: any;
  sentToPc?: any;
  pages?: any;
  finished?: boolean;
  pcPages?: any;
  pcPage?: number;
  pcResult?: any;
}

interface Input { wasPressed?: (k: string) => boolean }

// pokeemerald/src/naming_screen.c:1715
// Lua: naming.lua:36
function monTitle(speciesName?: unknown): string {
  // pokeemerald/src/text.c:972
  return tostring(truthy(speciesName) ? speciesName : "") + RomText.plain("gText_PkmnsNickname", { stringVars: {} });
}

// One UTF-8 character (Lua: "[%z\1-\127\194-\244][\128-\191]*").
const UTF8_CHAR = "[%z\x01-\x7F\xC2-\xF4][\x80-\xBF]*";
const UTF8_LAST = UTF8_CHAR + "$";

// pret sKeyboardChars + sPageColumnXPos (cursor).
const PAGES = seq<Page>(
  {
    id: "UPPER",
    rows: seq(
      seq("A", "B", "C", "D", "E", "F", " ", "."),
      seq("G", "H", "I", "J", "K", "L", " ", ","),
      seq("M", "N", "O", "P", "Q", "R", "S"),
      seq("T", "U", "V", "W", "X", "Y", "Z"),
    ),
    colX: seq(0, 12, 24, 56, 68, 80, 92, 123),
  },
  {
    id: "LOWER",
    rows: seq(
      seq("a", "b", "c", "d", "e", "f", " ", "."),
      seq("g", "h", "i", "j", "k", "l", " ", ","),
      seq("m", "n", "o", "p", "q", "r", "s"),
      seq("t", "u", "v", "w", "x", "y", "z"),
    ),
    colX: seq(0, 12, 24, 56, 68, 80, 92, 123),
  },
  {
    id: "OTHERS",
    rows: seq(
      seq("0", "1", "2", "3", "4"),
      seq("5", "6", "7", "8", "9"),
      // "!", "?", "♂", "♀", "/", "-"
      seq("!", "?", "\xE2\x99\x82", "\xE2\x99\x80", "/", "-"),
      // "…", "“", "”", "‘", "'"
      seq("\xE2\x80\xA6", "\xE2\x80\x9C", "\xE2\x80\x9D", "\xE2\x80\x98", "'"),
    ),
    colX: seq(0, 22, 44, 66, 88, 110),
  },
);

const KEY_TO_BTN = seq(0, 1, 1, 2) as number[];
const BTN_TO_KEY = seq(0, 0, 3) as number[];
const SIDE = seq("PAGE", "BACK", "OK");

// The Lua builds these small literal tables inline at their use; hoisted so a
// frame does not allocate them (same values).
const BTN_ROW = seq(1, 2, 4) as number[];
const RIVAL_SY = seq(0, 96, 0, 128) as number[];
const PLAYER_FRAMES = seq(3, 0, 4, 0) as number[];
const UNDERSCORE_BOB = seq(2, 3, 2, 1) as number[];
const ARROW_BOB = seq(0, -4, -2, -1) as number[];
const PAGE_BTN_KEYS = seq("page_swap_button_upper", "page_swap_button_lower", "page_swap_button_others");
const PAGE_LABEL_KEYS = seq("page_swap_upper", "page_swap_lower", "page_swap_others");

// pret naming_screen.c CreateSprite coords are *centers*; OAM top-left =
// center + centerToCornerVec. Subsprite sheets draw at first-subsprite TL.
// Values below are on-screen top-left blit positions (px).
const L = {
  titleX: 73, titleY: 33,
  // WIN_TEXT_ENTRY_BOX = {tilemapLeft 9, tilemapTop 4, width 16} → screen
  // x 72..200; the title prints at (1,1) inside it, so it has 127px before the
  // GBA's per-window clip (CopyGlyphToWindow) would truncate it.
  titleMaxW: 127,
  // Player/rival icon CreateSprite(56,37); 16×32 → TL (48,21)
  iconCX: 56, iconCY: 37,
  iconW: 16, iconH: 32,
  // Mon icon CreateMonIcon(species, SpriteCallbackDummy, 56, 40) is a 32×32
  // sprite (Versions.MON_ICON_W/H) drawn unscaled, centred on the frame baked
  // into bg.png — pokefirered/src/naming_screen.c:1422. Reusing the 16×32
  // player box above would letterbox it to half size.
  monIconCX: 56, monIconCY: 40,
  monIconW: 32, monIconH: 32,
  charY: 49,
  // Underscore CreateSprite(base+3,60) 8×8 → TL (base-1, 56)
  underscoreBaseY: 56,
  underscoreXOfs: -1,
  // Input arrow CreateSprite(base-5,56) 8×8 → TL (base-9, 52)
  arrowXOfs: -9,
  arrowY: 52,
  // Cursor CreateSprite(colX+38, row*16+88) 16×16 → TL (colX+30, row*16+80)
  cursorBaseX: 30,
  cursorBaseY: 80,
  kbX: 24,
  kbY: 80,
  // Keyboard chrome blit (border + SELECT tab); letters stay at kbX/kbY
  kbChromeX: 16,
  kbChromeY: 72,
  // First letter after {CLEAR 11}; colX aligns cursor to this grid
  keyTextOx: 11,
  keyTextOy: 1,
  // pret PrintControls WIN_BANNER: 240×16, stdpal_2[15] = RGB(0,123,197)
  bannerH: 16,
  bannerR: 0 / 255,
  bannerG: 123 / 255,
  bannerB: 197 / 255,
  // Page frame CreateSprite(204,88) + subsprite (-20,-16) → (184,72)
  pageFrameX: 184, pageFrameY: 72,
  // Page button CreateSprite(204,83) 32×16 → TL (188,75)
  pageBtnX: 188, pageBtnY: 75,
  // Page text CreateSprite(204,84) + subsprite (-12,-4) → (192,80)
  pageLabelX: 192, pageLabelY: 80,
  // BACK/OK CreateSprite(204,116/140) + subsprite (-20,-12) → (184,104/128)
  backX: 184, backY: 104,
  okX: 184, okY: 128,
  // Button pill cursor coordinates (32×13 pill at center 204, Y=88/116/140)
  btnCursorX: 188,
  btnCursorY: seq(77, 106, 128) as number[],
};

// Lua: naming.lua:134
function playSe(id?: number): void {
  Audio.playSe(id ?? 5);
}

// Lua: naming.lua:138
function utf8Len(s: unknown): number {
  let n = 0;
  for (const _ of gmatch(tostring(truthy(s) ? s : ""), UTF8_CHAR)) {
    n = n + 1;
  }
  return n;
}

// Lua: naming.lua:146
function utf8Trim(s: unknown, maxLen: number): string {
  const out: string[] = [];
  let n = 0;
  for (const [ch] of gmatch(tostring(truthy(s) ? s : ""), UTF8_CHAR)) {
    if (n >= maxLen) break;
    out.push(ch as string);
    n = n + 1;
  }
  return out.join("");
}

// Lua: naming.lua:156
function pagesOf(st: NamingState | null | undefined): any {
  return (st && st.pages) || PAGES;
}

// Lua: naming.lua:160
function pageInfo(st: NamingState): Page {
  return pagesOf(st)[st.page];
}

// Lua: naming.lua:164
function colCount(st: NamingState): number {
  const page = pageInfo(st);
  const row = page.rows[st.row];
  return row ? len(row) : 0;
}

// Lua: naming.lua:170
function onButtonCol(st: NamingState): boolean {
  return st.col > colCount(st);
}

// Lua: naming.lua:174
function clampCursor(st: NamingState): void {
  const n = colCount(st);
  if (st.col < 1) st.col = 1;
  if (st.col > n + 1) st.col = n + 1;
  if (st.row < 1) st.row = 1;
  if (st.row > 4) st.row = 4;
  if (onButtonCol(st)) {
    st.btn = KEY_TO_BTN[st.row]! + 1;
  }
}

// Lua: naming.lua:185
function cellAt(st: NamingState): string | null | undefined {
  if (onButtonCol(st)) return null;
  const page = pageInfo(st);
  const row = page.rows[st.row];
  return row && row[st.col];
}

// Lua: naming.lua:192
function appendChar(st: NamingState, ch: string | null | undefined): void {
  if (ch == null) return;
  if (utf8Len(st.name) >= st.maxLen) return;
  st.name = st.name + ch;
  if (utf8Len(st.name) >= st.maxLen) {
    st.col = colCount(st) + 1;
    st.row = 4;
    st.btn = 3;
  }
}

// Lua: naming.lua:203
function backspace(st: NamingState): void {
  if (st.name === "") return;
  st.name = gsub(st.name, UTF8_LAST, "")[0];
}

// pokefirered/src/naming_screen.c:866
// Lua: naming.lua:209
function gbaSin(idx: number, amp: number): number {
  return Math.floor(Math.sin(mod(idx, 256) * Math.PI / 128) * amp + 0.5);
}

// pokefirered/src/naming_screen.c:793
// Lua: naming.lua:214
function commitPage(st: NamingState): void {
  st.page = st.swapTo ?? st.page;
  st.swapTo = null;
  if (!onButtonCol(st)) {
    const n = colCount(st);
    if (st.col > n) st.col = n;
  }
}

// pokefirered/src/naming_screen.c:768
// Lua: naming.lua:224
function cyclePage(st: NamingState): void {
  if (st.swapT != null) return;
  st.swapTo = mod(st.page, len(pagesOf(st))) + 1;
  st.swapT = 0;
  playSe(6);
}

// Lua: naming.lua:231
function confirm(st: NamingState): any {
  const name = st.name;
  if (name == null || match(name, "^%s*$") != null) {
    return st.seed;
  }
  return utf8Trim(name, st.maxLen);
}

// Lua: naming.lua:239
function namingSession(st: NamingState | null | undefined): any {
  if (st && truthy(st.session)) return st.session;
  // NOT FAITHFUL (scope): the Lua asks the runtime only when it is already
  // loaded (package.loaded); here it is always imported.
  return (Runtime && Runtime.getSession && Runtime.getSession()) || null;
}

// pokefirered/src/naming_screen.c:696
// Lua: naming.lua:246
function caughtMonSentToPc(st: NamingState): boolean {
  if (st.sentToPc != null) return truthy(st.sentToPc);
  // NOT FAITHFUL (scope): the Lua reads catch_seq only when it is already
  // loaded (package.loaded); here it is always imported.
  const res = CatchSeq && CatchSeq.catchResult && CatchSeq.catchResult();
  return (res && res.location === "pc") ? true : false;
}

// pokefirered/src/naming_screen.c:732
// Lua: naming.lua:254
function sentToPcPages(st: NamingState, nick: any): any {
  if (st.template !== "CAUGHT_MON") return null;
  if (!caughtMonSentToPc(st)) return null;
  const session = namingSession(st);
  if (!truthy(session)) return null;
  // pcall(require, "src.core.game3.storage"): imported, okS is true
  if (!(Storage && Storage.pcTransferMessage)) return null;
  const full = Storage.isDestinationBoxFull(session);
  const text = Storage.pcTransferMessage(session, nick, full);
  if (typeof text !== "string" || text === "") return null;
  // TextIR.splitPages returns a 0-based JS array; the Lua's is a sequence.
  const pages = fromArray(TextIR.splitPages(text));
  if (len(pages) === 0) return null;
  return pages;
}

/** Draw keyboard letters at fixed colX cells (matches cursor grid; ignores glyph-width drift). */
// Lua: naming.lua:270
function drawKeyboardKeys(page: Page, colors: any): void {
  const rows = page.rows;
  const colX = page.colX;
  if (!rows || !colX) return;
  for (let r = 1; r <= len(rows); r++) {
    const row = rows[r];
    const y = L.kbY + (r - 1) * 16 + L.keyTextOy;
    for (let c = 1; c <= len(row); c++) {
      const ch = row[c];
      if (ch != null && ch !== "" && ch !== " ") {
        const x = L.kbX + L.keyTextOx + (colX[c] ?? 0);
        FrlgFont.draw(ch, x, y, {
          colors: colors,
          maxWidth: 16,
        });
      }
    }
  }
}

const KB_KEYS = seq("kb_upper", "kb_lower", "kb_symbols");

// pokefirered/src/naming_screen.c:2019
// Lua: naming.lua:293
function drawKeyboardPage(pageIdx: number, dy: number | null | undefined, pages: any): void {
  const page: Page | undefined = (pages || PAGES)[pageIdx];
  if (!page) return;
  G.push();
  G.translate(0, -(dy ?? 0));

  const kbKey = KB_KEYS[pageIdx] ?? "kb_upper";
  const kb = NamingChrome.get(kbKey);
  if (kb) {
    G.setColor(1, 1, 1, 1);
    const [iw, ih] = kb.getDimensions();
    if (iw >= 160 && ih >= 72) {
      // v3 frame crop (includes border/tab)
      G.draw(kb, L.kbChromeX, L.kbChromeY);
    } else if (iw <= 160 && ih <= 70) {
      // v2 inner-only crop (missing border) — legacy fallback
      G.draw(kb, L.kbX, L.kbY);
    } else {
      const [img, q] = NamingChrome.kbQuad(kbKey);
      if (img && q) {
        G.draw(img, q, L.kbChromeX, L.kbChromeY);
      } else if (img) {
        G.draw(img, L.kbChromeX, L.kbChromeY);
      }
    }
  }

  drawKeyboardKeys(page, FrlgFont.COLOR.WHITE);
  G.pop();
}

// Lua: naming.lua:324
function playerOwId(gender: any): any {
  const isFemale = gender === 1 || gender === "female" || gender === "F";
  const avatar = OwSprites.avatarGraphicsId("NORMAL", isFemale);
  if (truthy(avatar)) return avatar;
  if (isFemale) {
    return Versions.OW_PLAYER_FEMALE ?? 7;
  }
  return Versions.OW_PLAYER_MALE ?? 0;
}

// Lua: naming.lua:334
function drawPlayerIcon(st: NamingState): void {
  G.setColor(1, 1, 1, 1);
  const tlX = L.iconCX - L.iconW / 2;
  const tlY = L.iconCY - L.iconH / 2;

  if (st.template === "NICKNAME" || st.template === "CAUGHT_MON") {
    const species = tonumber(st.species) ?? 0;
    if (species > 0) {
      // pcall(require, "src.core.game3.pokemon"): imported, ok is true
      if (Pokemon) {
        // pokefirered/src/naming_screen.c:1422
        const entry = Pokemon.icon && Pokemon.icon(Pokemon.picSpecies(species, st.personality));
        if (entry && entry.image) {
          const iw = truthy(entry.w) ? entry.w : entry.image.getWidth();
          const ih = truthy(entry.h) ? entry.h
            : (truthy(entry.quads) && truthy(entry.h)) ? entry.h : entry.image.getHeight();
          const sc = Math.min(L.monIconW / iw, L.monIconH / ih);
          // pret passes SpriteCallbackDummy, so the icon shows its frame 0.
          const q = entry.quads && entry.quads[0];
          if (q) {
            G.draw(entry.image, q, L.monIconCX, L.monIconCY, 0, sc, sc, iw / 2, ih / 2);
          } else {
            G.draw(entry.image, L.monIconCX, L.monIconCY, 0, sc, sc, iw / 2, ih / 2);
          }
          return;
        }
      }
    }
  }

  if (st.template === "RIVAL") {
    const rival = NamingChrome.get("rival");
    if (rival) {
      const tick = mod(Math.floor((st.blink ?? 0) * 60 / 10), 4);
      const sy = RIVAL_SY[tick + 1] ?? 0;
      let q: Quad | undefined = Naming._rivalQuad;
      if (G.newQuad != null) {
        if (!q) {
          q = G.newQuad(0, sy, 16, 32, ...rival.getDimensions());
          Naming._rivalQuad = q;
        } else {
          q.setViewport(0, sy, 16, 32);
        }
        G.draw(rival, q, tlX, tlY);
        return;
      }
    }
  }

  const gid = playerOwId(st.gender);
  const spr = OwSprites.get(gid);
  if (spr && spr.image) {
    const tick = mod(Math.floor((st.blink ?? 0) * 60 / 8), 4);
    const frame = OwSprites.pose(spr, "down", false, false, {
      frame: PLAYER_FRAMES[tick + 1] ?? 0,
    });
    const q = spr.quads[frame];
    if (q) {
      const ox = tlX + (L.iconW - spr.width) / 2;
      const oy = tlY + (L.iconH - spr.height);
      G.draw(spr.image, q, ox, oy);
      return;
    }
  }

  // Fallback: explicit icon image (e.g. tests). Scale portraits into the OW slot.
  if (st.icon) {
    const [iw, ih] = st.icon.getDimensions();
    if (iw > 24 || ih > 40) {
      const sc = Math.min(L.iconW / iw, L.iconH / ih);
      G.draw(st.icon, L.iconCX, L.iconCY, 0, sc, sc, iw / 2, ih / 2);
    } else {
      G.draw(st.icon, tlX, tlY);
    }
  }
}

// Lua: naming.lua:410
function cacheManifest(): any {
  // love.filesystem.load always exists here
  let ok: boolean, chunk: unknown;
  try { chunk = Fs.load("data/generated/gba/naming/manifest.lua")[0]; ok = true; } catch { ok = false; }
  if (!ok || typeof chunk !== "function") return null;
  let ok2: boolean, t: unknown;
  try { t = (chunk as () => unknown)(); ok2 = true; } catch { ok2 = false; }
  if (ok2 && typeof t === "object" && t !== null) return t;
  return null;
}

// pokeemerald/src/naming_screen.c:280
const KB_ORDER = seq({ id: "UPPER", kb: 2 }, { id: "LOWER", kb: 1 }, { id: "OTHERS", kb: 3 });

// Lua: naming.lua:422
function pagesFromKeyboard(kb: any): any {
  if (typeof kb !== "object" || kb === null || typeof kb.chars !== "object" || kb.chars === null) return null;
  const pages: any[] = [null];
  for (const [i, entry] of ipairs<{ id: string; kb: number }>(KB_ORDER)) {
    const chars = kb.chars[entry.kb];
    const count = (kb.columnCounts && kb.columnCounts[entry.kb]) ?? 8;
    const rows: any[] = [null];
    for (const [r, row] of ipairs<any>(chars ?? {})) {
      const out: any[] = [null];
      for (let c = 1; c <= count; c++) {
        const cell = row[c];
        out[c] = (cell && truthy(cell.char)) ? cell.char : " ";
      }
      rows[r] = out;
    }
    const colX: any[] = [null];
    for (let c = 1; c <= count; c++) {
      colX[c] = (kb.columnX && kb.columnX[entry.kb] && kb.columnX[entry.kb][c]) ?? 0;
    }
    pages[i] = { id: entry.id, rows: rows, colX: colX };
  }
  return pages;
}

// Lua: naming.lua:444
function templateFromManifest(man: any, name: unknown): any {
  if (typeof man !== "object" || man === null || typeof man.templates !== "object" || man.templates === null) return null;
  for (const [i, key] of ipairs<string>(Naming.TEMPLATE_ORDER)) {
    if (key === name) return man.templates[i];
  }
  // NOT FAITHFUL: error(msg, 3) prefixes the caller's chunk:line; this message has no prefix.
  throw new Error("naming: template " + tostring(name) + " does not exist in this game's naming screen");
}

// Lua: naming.lua:452
function open(opts?: any): NamingState {
  opts = opts ?? {};
  {
    // NOT FAITHFUL (scope): the Lua closes the stay message only when
    // src.ui.game3.message is already loaded (package.loaded); here it is
    // always imported.
    const StayMessage = Message;
    if (StayMessage && StayMessage.closeStay) StayMessage.closeStay();
  }
  const man = cacheManifest();
  const tpl = Naming.templateFromManifest(man, opts.template ?? "PLAYER");
  // pcall(require, "src.ui.game3.fade"): imported, okF is true
  if (Fade && Fade.clear) {
    Fade.clear();
  }
  NamingChrome.ready();
  const st: NamingState = {
    title: opts.title ?? (tpl && tpl.title) ?? RomText.plain("gText_YourName"),
    maxLen: opts.maxLen ?? (tpl && tpl.maxChars) ?? Naming.MAX_LEN,
    name: tostring(opts.initialText ?? ""),
    seed: opts.seed,
    page: 1,
    row: 1,
    col: 1,
    btn: 1,
    blink: 0,
    swapT: null,
    icon: opts.icon,
    gender: opts.gender ?? 0,
    template: opts.template ?? "PLAYER",
    species: opts.species,
    personality: opts.personality,
    onDone: opts.onDone,
    hold: opts.hold,
    session: opts.session,
    sentToPc: opts.sentToPc,
    pages: (man && Naming.pagesFromKeyboard(man.keyboard)) ?? null,
  };
  Naming._state = st;
  Naming.openFlag = true;
  Stack.push("naming", Naming, { hideBelow: true, fullscreen: true });
  return st;
}

// Lua: naming.lua:493
function isOpen(): boolean {
  return Naming.openFlag;
}

// Lua: naming.lua:497
function close(result?: any): void {
  const st = Naming._state;
  if (st && truthy(st.hold)) {
    if (st.finished) return;
    st.finished = true;
    if (st.onDone) st.onDone(result);
    return;
  }
  const cb = st && st.onDone;
  Naming.openFlag = false;
  Naming._state = null;
  Stack.pop("naming");
  if (cb) cb(result);
}

// Lua: naming.lua:512
function dismiss(): void {
  Naming.openFlag = false;
  Naming._state = null;
  Stack.pop("naming");
}

// Timer half of the naming tick.  Input arrives through handleInput -- the stack
// convention Hud.update_top_menu uses.  Passing the delta here was the bug:
// Naming.update(input, dt) was being called as update(dt), so the delta arrived
// as `input` and indexing it raised every frame the screen was on top.
// Lua: naming.lua:522
function update(dt?: number): void {
  if (!Naming.openFlag || !Naming._state) return;
  const st = Naming._state;
  if (st.finished) return;
  // The pcPages result screen owns this state: the original returned before
  // touching the blink timer, so keep that here.
  if (st.pcPages) return;
  st.blink = (st.blink ?? 0) + (dt ?? 1 / 60);
  if (st.swapT != null) {
    st.swapT = st.swapT + 4;
    if (st.swapT >= 128) {
      commitPage(st);
      st.swapT = null;
    }
  }
}

// Input half.  Call it before update() so the ordering matches the original
// single function (pcPages and the swap guard are consumed before the timers).
// Lua: naming.lua:541
function handleInput(input?: Input | null): void {
  if (!Naming.openFlag || !Naming._state) return;
  const st = Naming._state;
  if (st.finished) return;
  // Input is ignored while the page swap runs (the original returned here).
  if (st.swapT != null) return;
  // pokefirered/src/naming_screen.c:759
  if (st.pcPages) {
    if (input && input.wasPressed && input.wasPressed("a")) {
      if (st.pcPage! < len(st.pcPages)) {
        st.pcPage = st.pcPage! + 1;
      } else {
        Naming.close(st.pcResult);
      }
    }
    return;
  }

  const pressed = (k: string): boolean | undefined => {
    return (input && input.wasPressed && input.wasPressed(k)) || undefined;
  };

  if (pressed("select")) {
    cyclePage(st);
    return;
  }
  if (pressed("b")) {
    playSe(23);
    backspace(st);
    return;
  }
  if (pressed("start")) {
    st.col = colCount(st) + 1;
    st.row = 4;
    st.btn = 3;
    return;
  }

  if (pressed("up")) {
    if (onButtonCol(st)) {
      st.btn = st.btn - 1;
      if (st.btn < 1) st.btn = 3;
      st.row = BTN_ROW[st.btn]!;
    } else {
      st.row = st.row - 1;
      if (st.row < 1) st.row = 4;
      clampCursor(st);
    }
  } else if (pressed("down")) {
    if (onButtonCol(st)) {
      st.btn = st.btn + 1;
      if (st.btn > 3) st.btn = 1;
      st.row = BTN_ROW[st.btn]!;
    } else {
      st.row = st.row + 1;
      if (st.row > 4) st.row = 1;
      clampCursor(st);
    }
  } else if (pressed("left")) {
    if (onButtonCol(st)) {
      st.col = colCount(st);
      st.row = BTN_TO_KEY[st.btn]! + 1;
    } else {
      st.col = st.col - 1;
      if (st.col < 1) {
        st.col = colCount(st) + 1;
        st.btn = KEY_TO_BTN[st.row]! + 1;
      }
    }
  } else if (pressed("right")) {
    if (onButtonCol(st)) {
      st.col = 1;
      st.row = BTN_TO_KEY[st.btn]! + 1;
    } else {
      const n = colCount(st);
      if (st.col >= n) {
        st.col = n + 1;
        st.btn = KEY_TO_BTN[st.row]! + 1;
      } else {
        st.col = st.col + 1;
      }
    }
  } else if (pressed("a")) {
    if (onButtonCol(st)) {
      const role = SIDE[st.btn];
      if (role === "PAGE") {
        cyclePage(st);
      } else if (role === "BACK") {
        playSe(23);
        backspace(st);
      } else if (role === "OK") {
        playSe(5); // pokefirered/src/naming_screen.c:1535
        const nick = confirm(st);
        const pages = sentToPcPages(st, nick);
        if (pages) {
          st.pcPages = pages;
          st.pcPage = 1;
          st.pcResult = nick;
        } else {
          Naming.close(nick);
        }
      }
    } else {
      playSe(5); // pokefirered/src/naming_screen.c:1837
      appendChar(st, cellAt(st));
    }
  }
}

// Lua: naming.lua:650
function drawText(str: unknown, x: number, y: number, opts?: { colors?: any; small?: any; maxWidth?: number }): void {
  opts = opts ?? {};
  FrlgFont.draw(tostring(truthy(str) ? str : ""), x, y, {
    colors: opts.colors ?? FrlgFont.COLOR.NORMAL,
    small: opts.small,
    maxWidth: opts.maxWidth ?? 240,
  });
}

// Lua: naming.lua:659
function blit(key: string, x: number, y: number): void {
  const img = NamingChrome.get(key);
  if (img) {
    G.setColor(1, 1, 1, 1);
    G.draw(img, x, y);
  }
}

// Lua: naming.lua:667
function pulseAmt(st: NamingState): number {
  return 0.5 + 0.5 * Math.sin((st.blink ?? 0) * Math.PI * 3);
}

// 32×13 pixel-perfect outline mask matching GBA button index 14 outline (78 pixels)
const BTN_MASK_32x13 = seq(
  "  ############################  ",
  " #                            # ",
  "#                              #",
  "#                              #",
  "#                              #",
  "#                              #",
  "#                              #",
  "#                              #",
  "#                              #",
  "#                              #",
  "#                              #",
  " #                            # ",
  "  ############################  ",
);

let btnCursorImg: Image | null = null;

// Lua: naming.lua:689
function getButtonCursorImage(): Image | null {
  if (btnCursorImg) return btnCursorImg;
  // love.image.newImageData and love.graphics.newImage always exist here
  let ok: boolean, imgData: ImageData | undefined;
  try { imgData = newImageData(32, 13); ok = true; } catch { ok = false; }
  if (!ok || !imgData) return null;
  for (let y = 0; y <= 12; y++) {
    const row = BTN_MASK_32x13[y + 1] ?? "";
    for (let x = 0; x <= 31; x++) {
      const ch = sub(row, x + 1, x + 1);
      if (ch === "#") {
        imgData.setPixel(x, y, 1, 1, 1, 1);
      } else {
        imgData.setPixel(x, y, 0, 0, 0, 0);
      }
    }
  }
  let ok2: boolean, img: Image | undefined;
  try { img = G.newImage(imgData); ok2 = true; } catch { ok2 = false; }
  if (ok2 && img) {
    if (img.setFilter) img.setFilter("nearest", "nearest");
    btnCursorImg = img;
    return btnCursorImg;
  }
  return null;
}

// Lua: naming.lua:716
function blitButtonBorder(btnIdx: number): void {
  const st = Naming._state!;
  const pulse = pulseAmt(st);
  const bx = L.btnCursorX ?? 188;
  const by = (L.btnCursorY && L.btnCursorY[btnIdx]) ?? (btnIdx === 1 ? 77 : (btnIdx === 2 ? 106 : 128));
  const glowKey = (btnIdx === 1 && "page_swap_button_glow") || (btnIdx === 2 && "back_button_glow") || "ok_button_glow";
  const frameX = (btnIdx === 1 && L.pageFrameX) || (btnIdx === 2 && L.backX) || L.okX;
  const frameY = (btnIdx === 1 && L.pageFrameY) || (btnIdx === 2 && L.backY) || L.okY;

  const r = 1.0;
  const gb = (8 / 255) + pulse * (220 / 255);

  const glowImg = NamingChrome.get(glowKey);
  if (glowImg) {
    G.setColor(r, gb, gb, 1.0);
    G.draw(glowImg, frameX, frameY);
    G.setColor(1, 1, 1, 1);
    return;
  }

  const cursorImg = getButtonCursorImage();
  if (cursorImg) {
    G.setColor(r, gb, gb, 1.0);
    G.draw(cursorImg, bx, by);
    G.setColor(1, 1, 1, 1);
    return;
  }

  // Procedural 32×13 pixel-perfect fallback matching 78-pixel index 14 outline
  if (G.rectangle != null) {
    G.setColor(r, gb, gb, 1.0);
    // Top & bottom horizontal bars (1px thick, 28px wide from x=2 to 29)
    G.rectangle("fill", bx + 2, by, 28, 1);
    G.rectangle("fill", bx + 2, by + 12, 28, 1);
    // Left & right vertical bars (1px thick, 9px high from y=2 to 10)
    G.rectangle("fill", bx, by + 2, 1, 9);
    G.rectangle("fill", bx + 31, by + 2, 1, 9);
    // Corner bevel pixels at y=1 and y=11
    G.rectangle("fill", bx + 1, by + 1, 1, 1);
    G.rectangle("fill", bx + 30, by + 1, 1, 1);
    G.rectangle("fill", bx + 1, by + 11, 1, 1);
    G.rectangle("fill", bx + 30, by + 11, 1, 1);
    G.setColor(1, 1, 1, 1);
  }
}

// Lua: naming.lua:762
function draw(): void {
  if (!Naming.openFlag || !Naming._state) return;
  const st = Naming._state;
  const W = Display.W, H = Display.H;
  const page = pageInfo(st);

  // 1) Background (240×160)
  const bg = NamingChrome.get("bg");
  if (bg) {
    G.setColor(1, 1, 1, 1);
    G.draw(bg, 0, 0);
  } else {
    G.setColor(0.42, 0.61, 0.84, 1);
    G.rectangle("fill", 0, 0, W, H);
  }

  // 2/3) Keyboard chrome + letters (extract v3 is 176×80 at 16,72)
  if (st.swapT != null && st.swapTo) {
    // pokefirered/src/naming_screen.c:857
    const dIn = gbaSin(st.swapT, 40);
    const dOut = gbaSin(st.swapT + 128, 40);
    if (st.swapT < 64) {
      drawKeyboardPage(st.swapTo, dIn, st.pages);
      drawKeyboardPage(st.page, dOut, st.pages);
    } else {
      drawKeyboardPage(st.page, dOut, st.pages);
      drawKeyboardPage(st.swapTo, dIn, st.pages);
    }
  } else {
    drawKeyboardPage(st.page, 0, st.pages);
  }

  const nextPage = mod(st.page, len(pagesOf(st))) + 1;
  const onSide = onButtonCol(st);
  // pokefirered/src/naming_screen.c:1293
  let labelPage = nextPage, labelDy = 0, labelShow = true;
  if (st.swapT != null && st.swapTo) {
    const f = st.swapT / 4;
    if (f < 8) {
      labelDy = f;
    } else {
      labelPage = mod(st.swapTo, len(pagesOf(st))) + 1;
      if (f === 8) {
        labelShow = false;
      } else {
        labelDy = Math.min(0, -4 + (f - 8));
      }
    }
  }
  const pageBtn = PAGE_BTN_KEYS[labelPage];
  blit("page_swap_frame", L.pageFrameX, L.pageFrameY);
  blit(pageBtn ?? "page_swap_button", L.pageBtnX, L.pageBtnY);
  if (labelShow) {
    blit(PAGE_LABEL_KEYS[labelPage]!,
      L.pageLabelX, L.pageLabelY + labelDy);
  }
  blit("back_button", L.backX, L.backY);
  blit("ok_button", L.okX, L.okY);
  if (onSide && st.btn) {
    blitButtonBorder(st.btn);
  }

  // 5) Title + icon + typed name (above KB)
  G.setColor(1, 1, 1, 1);
  // Clamp to the text-entry window so an over-long title cannot spill over the
  // frame (pret blits glyphs into the window buffer and clips there).
  drawText(st.title, L.titleX, L.titleY, { maxWidth: L.titleMaxW });

  drawPlayerIcon(st);

  const baseX = Math.floor((W - st.maxLen * 8) / 2) + 6;
  const chars: (string | null)[] = [null];
  for (const [ch] of gmatch(tostring(st.name), UTF8_CHAR)) {
    chars[len(chars) + 1] = ch as string;
  }
  const caret = len(chars) + 1;
  for (let i = 1; i <= st.maxLen; i++) {
    const x = baseX + (i - 1) * 8;
    if (chars[i] != null) {
      drawText(chars[i], x, L.charY);
    }
    const und = NamingChrome.get("underscore");
    if (und) {
      let bobY = 0;
      if (i === caret) {
        const bob = mod(Math.floor(st.blink * 8), 4);
        bobY = UNDERSCORE_BOB[bob + 1] ?? 2;
      }
      G.setColor(1, 1, 1, 1);
      G.draw(und, x + L.underscoreXOfs, L.underscoreBaseY + bobY);
    }
  }
  const arrow = NamingChrome.get("input_arrow");
  if (arrow) {
    const bob = mod(Math.floor(st.blink * 8), 4);
    const x2 = ARROW_BOB[bob + 1] ?? 0;
    G.setColor(1, 1, 1, 1);
    G.draw(arrow, baseX + L.arrowXOfs + x2, L.arrowY);
  }

  // 6) Cursor (pret center (38+colX, 88+row*16) → TL via -8,-8)
  // pokefirered/src/naming_screen.c:773
  if (!onButtonCol(st) && st.swapT == null) {
    const x = L.cursorBaseX + (page.colX[st.col] ?? 0);
    const y = L.cursorBaseY + (st.row - 1) * 16;
    const [img, q] = NamingChrome.cursorQuad(0);
    if (img && q) {
      const pulse = pulseAmt(st);
      G.setColor(1, 1, 1, 12 / 16);
      G.draw(img, q, x, y);
      G.setBlendMode("add");
      G.setColor(pulse * 0.55, pulse * 0.55, pulse * 0.55, 1);
      G.draw(img, q, x, y);
      G.setBlendMode("alpha");
      G.setColor(1, 1, 1, 1);
    } else {
      G.setColor(1, 0.1, 0.1, 0.75);
      G.rectangle("line", x, y, 16, 16);
    }
  }

  // 7) Banner — pret PrintControls / WIN_BANNER (bg0, 30×2 tiles).
  // Fill PIXEL_FILL(15) of GetTextWindowPalette(2) = RGB(0,123,197), then
  // gText_MoveOkBack right-aligned in FONT_SMALL (keypad icons ≈ + / A / B).
  G.setColor(L.bannerR, L.bannerG, L.bannerB, 1);
  G.rectangle("fill", 0, 0, W, L.bannerH);
  PokedexChrome.drawControlInfo(RomText.plain("gText_MoveOkBack"), W - 4, 0);

  // pokefirered/src/naming_screen.c:753
  if (st.pcPages) {
    Chrome.dialogueFrame();
    FrlgFont.draw(st.pcPages[st.pcPage!] ?? "",
      Chrome.DLG_LEFT * Display.TILE, Chrome.DLG_TOP * Display.TILE + 1,
      { maxWidth: Chrome.DLG_W * Display.TILE, colors: FrlgFont.COLOR.NORMAL });
  }
}

// Lua: naming.lua:903
function begin(opts?: any): NamingState {
  opts = opts ?? {};
  return {
    title: opts.title ?? RomText.plain("gText_YourName"),
    maxLen: opts.maxLen ?? Naming.MAX_LEN,
    name: "",
    seed: opts.default ?? opts.seed,
    page: 1, row: 1, col: 1, btn: 1, blink: 0,
    onDone: opts.onDone,
  };
}

export const Naming = {
  isMenu: true,

  MAX_LEN: 7,
  openFlag: false,
  _state: null as NamingState | null,
  _rivalQuad: undefined as Quad | undefined,

  TEMPLATE: {
    PLAYER: "PLAYER",
    RIVAL: "RIVAL",
    BOX: "BOX",
    CAUGHT_MON: "CAUGHT_MON",
    NICKNAME: "NICKNAME",
    WALDA: "WALDA",
  },

  // pokeemerald/include/naming_screen.h:7
  TEMPLATE_ORDER: seq("PLAYER", "BOX", "CAUGHT_MON", "NICKNAME", "WALDA"),

  L: L,

  monTitle,
  pagesFromKeyboard,
  templateFromManifest,
  open,
  isOpen,
  close,
  dismiss,
  update,
  handleInput,
  draw,
  begin,
};

export default Naming;
