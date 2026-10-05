// Port of gen1recomp src/ui/game3/fame_checker.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/fame_checker.c:625 UseFameChecker
//
// Brian's lazyModule(name) is `pcall(require, name)`; every module it names is
// part of the port, so it is the static import. A module that is still a stub
// stands for the failed require: its NotPortedError is caught where it is
// called (viaStub) and Brian's fallback runs.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring } from "../../../import/gen3/lua.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { Stack } from "./stack.ts";
import { Window } from "./window.ts";
import { FrlgFont } from "./frlg_font.ts";
import { FameChecker } from "../core/fame_checker.ts";
import { TextIR } from "../core/scripting/text_ir.ts";
import { RomText } from "../core/rom_text.ts";
import { OwSprites as OwSpritesM } from "../core/ow_sprites.ts";
import { BagChrome as BagChromeM } from "./bag_chrome.ts";
import { PokedexChrome as PokedexChromeM } from "./pokedex_chrome.ts";
import { SE } from "../core/se_ids.ts";
import { Audio } from "../core/audio.ts";
import { Dataset } from "../core/dataset.ts";
import { Trainers } from "../core/scripting/trainers.ts";
import { NotPortedError } from "../notported.ts";
import { G } from "../platform/graphics.ts";
import { Fs } from "../platform/fs.ts";
import { newImageData, type Image } from "../platform/image.ts";
import { luaLoad } from "../platform/luadata.ts";
import { len, seq, type LuaTable } from "../platform/lt.ts";

interface Row { person?: number; cancel?: boolean; label: string }
interface Icon { unlocked: boolean; graphicsId: number | null }

// Brian's `local PERSON = FameChecker.PERSON` (and PICK, NSLOT()) are read where
// used: no top-level reads of imports (the gen3 import cycle).
function PICK(): Record<string, number> { return FameChecker.PICKSTATE as Record<string, number>; }
function NSLOT(): number { return FameChecker.NUM_FLAVOR_TEXTS; }

const CACHE_SUB = "fame_checker";

// pokefirered/src/fame_checker.c:1576 FC_PopulateListMenu
const MAX_SHOWED = 5;
// pokefirered/src/fame_checker.c:1524 FC_DoMoveCursor
const ROW_H = 14;

// pokefirered/src/fame_checker.c:474 sUIWindowTemplates
const LIST_WIN = seq(1, 3, 8, 10) as number[];
const HELP_WIN = seq(6, 0, 24, 2) as number[];
const ICONDESC_WIN = seq(15, 10, 11, 4) as number[];

// pokefirered/src/fame_checker.c:1339 PERSON_X / PERSON_Y
const PERSON_X = 148, PERSON_Y = 66;
const PORTRAIT = 64;

// pokefirered/src/fame_checker.c:171 sFameCheckerTrainerPicIdxs (Lua [0] = first: 0-based)
const TRAINER_PIC: number[] = [86, 84, 116, 117, 118, 119, 120, 122, 121, 112, 113, 114, 115, 100, 123, 108];

// pokefirered/src/fame_checker.c:1342 CreatePersonPicSprite
let ownArt: Record<number, boolean> | undefined;
function OWN_ART(): Record<number, boolean> {
  if (!ownArt) {
    const PERSON = FameChecker.PERSON as Record<string, number>;
    ownArt = {
      [PERSON.OAK!]: true,
      [PERSON.DAISY!]: true,
      [PERSON.BILL!]: true,
      [PERSON.MRFUJI!]: true,
    };
  }
  return ownArt;
}

// pokefirered/src/fame_checker.c:265 sFameCheckerArrayNpcGraphicsIds (Lua [0] keys: 0-based)
const ICON_GFX: number[][] = [
  [103, 71, 48, 105, 75, 55],
  [55, 48, 61, 105, 35, 105],
  [102, 80, 27, 19, 30, 105],
  [102, 81, 43, 39, 29, 105],
  [102, 82, 61, 61, 62, 105],
  [102, 83, 22, 29, 83, 105],
  [102, 84, 26, 22, 105, 30],
  [102, 25, 85, 85, 105, 41],
  [102, 86, 55, 28, 105, 105],
  [77, 77, 32, 105, 17, 35],
  [79, 79, 105, 54, 29, 54],
  [75, 54, 54, 105, 75, 35],
  [74, 74, 24, 23, 105, 41],
  [72, 18, 32, 89, 89, 89],
  [17, 49, 105, 30, 105, 105],
  [87, 55, 55, 87, 91, 55],
];

/** `pcall` around a call into a module that may still be a stub: [ok, value]. */
function viaStub<T>(f: () => T): [boolean, T | undefined] {
  try {
    return [true, f()];
  } catch (e) {
    if (e instanceof NotPortedError) return [false, undefined];
    throw e;
  }
}

// Lua: fame_checker.lua:73
function lazyModule<T>(get: () => T): () => T | null {
  // pcall(require, name): every named module is part of the port
  let mod: T | false | undefined;
  return () => {
    if (mod == null) mod = get() ?? false;
    return mod || null;
  };
}

const owSprites = lazyModule<any>(() => OwSpritesM);
const bagChrome = lazyModule<any>(() => BagChromeM);
const pokedexChrome = lazyModule<any>(() => PokedexChromeM);

// Lua: fame_checker.lua:89
function se(id: number | undefined): void {
  try {
    const A: any = Audio;
    if (A && A.playSe) A.playSe(id);
  } catch { /* pcall */ }
}

// Lua: fame_checker.lua:96
function read_bytes(rel: string): string | null {
  {
    const D: any = Dataset;
    if (D && D.cache) {
      let d: unknown;
      try { d = D.cache().read(rel); } catch { d = undefined; }
      if (typeof d === "string" && d.length > 0) return d;
    }
  }
  {
    // pcall(require, "src.import.CacheFs")
    const C: any = CacheFs;
    if (C && C.readActive) {
      let d: unknown;
      try { d = C.readActive(rel); } catch { d = undefined; }
      if (typeof d === "string" && d.length > 0) return d;
    }
  }
  {
    let d: unknown;
    try { d = Fs.read(rel); } catch { d = undefined; }
    if (typeof d === "string" && d.length > 0) return d;
  }
  // NOT FAITHFUL: no io.open fallback on the 3DS.
  return null;
}

// Lua: fame_checker.lua:120
function cache_root(): string {
  return Extract.CACHE_ROOT || "data/generated/gba";
}

// Lua: fame_checker.lua:126
function art_root(): string {
  return cache_root() + "/" + CACHE_SUB;
}

// Lua: fame_checker.lua:130
function rgba_to_image(rgba: string | null, w: number, h: number): Image | null {
  if (!rgba || rgba.length < w * h * 4) return null;
  let data;
  try { data = newImageData(w, h, "rgba8", rgba); } catch { return null; }
  let img: Image;
  try { img = G.newImage(data); } catch { return null; }
  if (img.setFilter) img.setFilter("nearest", "nearest");
  return img;
}

// Lua: fame_checker.lua:143
function art(key: string, rel: string, w: number, h: number): Image | null {
  if (FameCheckerUi._images[key] == null) {
    const bytes = read_bytes(art_root() + "/" + rel);
    FameCheckerUi._images[key] = (bytes && rgba_to_image(bytes, w, h)) || false;
  }
  return FameCheckerUi._images[key] || null;
}

// pokefirered/src/fame_checker.c:1563
// Lua: fame_checker.lua:200
function nonTrainerName(trainerId: number | undefined): string | null {
  if (trainerId == null || trainerId < FameChecker.NON_TRAINER_START) return null;
  return RomText.at("sNonTrainerNamePointers", trainerId - FameChecker.NON_TRAINER_START);
}

// Lua: fame_checker.lua:235
function textCtx(): any {
  const session = FameCheckerUi._session;
  return {
    playerName: (session && (session.name || session.playerName)) || "PLAYER",
    rivalName: (session && (session.rivalName || session.rival)) || "RIVAL",
  };
}

// Lua: fame_checker.lua:245
function pages(text: unknown): (string | null)[] | null {
  if (typeof text !== "string" || text === "") return null;
  const memo = FameCheckerUi._pageMemo[text];
  if (memo != null) {
    if (memo === false) return null;
    return memo;
  }
  const ir = TextIR.fromAscii(text);
  const ctx = textCtx();
  const out: (string | null)[] = [null];
  let idx = 1, kind: string | undefined;
  do {
    let page: string;
    [page, idx, kind] = TextIR.expandPage(ir, idx, ctx);
    if (page && page !== "") out[len(out) + 1] = page;
  } while (!(kind === "eos" || !kind));
  if (len(out) < 1) {
    FameCheckerUi._pageMemo[text] = false;
    return null;
  }
  FameCheckerUi._pageMemo[text] = out;
  return out;
}

// Lua: fame_checker.lua:319
function cachedRows(): (Row | null)[] {
  return FameCheckerUi._rows || FameCheckerUi.rows();
}

// pokefirered/src/fame_checker.c:1576 FC_PopulateListMenu
// Lua: fame_checker.lua:329
function maxShowed(total: number): number {
  if (total < MAX_SHOWED) return total;
  return MAX_SHOWED;
}

// Lua: fame_checker.lua:358
function cachedIcons(person: unknown): Icon[] | null {
  const p = tonumber(person);
  if (p == null) return null;
  return FameCheckerUi._icons[p] || FameCheckerUi.icons(p);
}

// Lua: fame_checker.lua:388
function clamp_cursor(): void {
  const total = len(cachedRows());
  const shown = maxShowed(total);
  if (FameCheckerUi.cursor > total) FameCheckerUi.cursor = total;
  if (FameCheckerUi.cursor < 1) FameCheckerUi.cursor = 1;
  if (FameCheckerUi.scroll > total - shown) FameCheckerUi.scroll = total - shown;
  if (FameCheckerUi.scroll < 0) FameCheckerUi.scroll = 0;
  if (FameCheckerUi.cursor <= FameCheckerUi.scroll) {
    FameCheckerUi.scroll = FameCheckerUi.cursor - 1;
  }
  if (FameCheckerUi.cursor > FameCheckerUi.scroll + shown) {
    FameCheckerUi.scroll = FameCheckerUi.cursor - shown;
  }
  if (FameCheckerUi.scroll < 0) FameCheckerUi.scroll = 0;
}

// pokefirered/src/list_menu.c:438 ListMenuUpdateSelectedRowIndexAndScrollOffset
// Lua: fame_checker.lua:405
function listStep(movingDown: boolean): boolean {
  const total = len(cachedRows());
  const shown = maxShowed(total);
  let scroll = FameCheckerUi.scroll;
  const itemsAbove = FameCheckerUi.cursor - 1 - scroll;
  let newRow: number;
  if (!movingDown) {
    if (shown === 1) {
      newRow = 0;
    } else {
      newRow = shown - (Math.floor(shown / 2) + shown % 2) - 1;
    }
    if (scroll === 0) {
      if (itemsAbove === 0) return false;
      FameCheckerUi.cursor = scroll + (itemsAbove - 1) + 1;
      return true;
    }
    if (itemsAbove > newRow) {
      FameCheckerUi.cursor = scroll + (itemsAbove - 1) + 1;
      return true;
    }
    scroll = scroll - 1;
  } else {
    if (shown === 1) {
      newRow = 0;
    } else {
      newRow = Math.floor(shown / 2) + shown % 2;
    }
    if (scroll === total - shown) {
      if (itemsAbove >= shown - 1) return false;
      FameCheckerUi.cursor = scroll + (itemsAbove + 1) + 1;
      return true;
    }
    if (itemsAbove < newRow) {
      FameCheckerUi.cursor = scroll + (itemsAbove + 1) + 1;
      return true;
    }
    scroll = scroll + 1;
  }
  FameCheckerUi.scroll = scroll;
  FameCheckerUi.cursor = scroll + newRow + 1;
  return true;
}

// Lua: fame_checker.lua:476
function rebuild_flavor_pages(): void {
  const person = FameCheckerUi.selectedPerson();
  const slot = FameCheckerUi.iconCursor;
  FameCheckerUi.textPage = 1;
  if (person == null || !FameChecker.hasFlavorText(FameCheckerUi._session, person, slot)) {
    FameCheckerUi._pages = null;
    return;
  }
  FameCheckerUi._pages = pages(FameCheckerUi.flavorText(person, slot))
    || seq(FameCheckerUi.personName(person));
}

// pokefirered/src/fame_checker.c:805 TryExitPickMode
// Lua: fame_checker.lua:537
function tryExitPickMode(): boolean {
  if (!FameCheckerUi.pickMode) return false;
  FameCheckerUi.pickMode = false;
  return true;
}

// pokefirered/src/fame_checker.c:729 Task_TopMenuHandleInput
// Lua: fame_checker.lua:544
function moveListCursor(movingDown: boolean): void {
  if (!listStep(movingDown)) return;
  FameCheckerUi.iconCursor = 0;
  se(SE.SE_SELECT);
}

// pokefirered/src/fame_checker.c:861 Task_FlavorTextDisplayHandleInput
// Lua: fame_checker.lua:551
function moveIconCursor(delta: string): void {
  let slot = FameCheckerUi.iconCursor;
  if (delta === "updown") {
    if (slot >= 3) slot = slot - 3; else slot = slot + 3;
  } else if (delta === "left") {
    if (slot % 3 === 0) slot = slot + 2; else slot = slot - 1;
  } else if (delta === "right") {
    if ((slot + 1) % 3 === 0) slot = slot - 2; else slot = slot + 1;
  }
  FameCheckerUi.iconCursor = slot;
  se(SE.SE_M_SWAGGER2);
  rebuild_flavor_pages();
}

// pokefirered/src/event_object_movement.c:1776 CreateFameCheckerObject
// Lua: fame_checker.lua:634
function iconCenter(slot: number): [number, number] {
  return [47 * (slot % 3) + 0x72, 27 * Math.floor(slot / 3) + 0x2F - 16];
}

// pokefirered/src/fame_checker.c:1281 PlaceQuestionMarkTile
// Lua: fame_checker.lua:639
function questionCenter(slot: number): [number, number] {
  return [47 * (slot % 3) + 0x72, 27 * Math.floor(slot / 3) + 0x1F];
}

// pokefirered/src/fame_checker.c:1264 CreateFlavorTextIconSelectorCursorSprite
// Lua: fame_checker.lua:644
function selectorCenter(slot: number): [number, number] {
  return [114 + 47 * (slot % 3), 34 + 27 * (slot >= 3 ? 1 : 0)];
}

// pokefirered/src/fame_checker.c:703 BLDALPHA 0x07
const BLEND_EVA = 7 / 16;

// Lua: fame_checker.lua:651
function draw_icons(person: number, selected: number | null): void {
  const OwSprites = owSprites();
  const icons = cachedIcons(person)!;
  for (let slot = 0; slot <= NSLOT() - 1; slot++) {
    const icon = icons[slot]!;
    if (icon.unlocked) {
      const [cx, cy] = iconCenter(slot);
      let drawn = false;
      if (OwSprites && OwSprites.get && icon.graphicsId != null) {
        const spr = OwSprites.get(icon.graphicsId);
        const quad = spr && spr.quads && spr.quads[0];
        if (spr && quad) {
          // pokefirered/src/fame_checker.c:781 SetMessageSelectorIconObjMode
          const k = (selected != null && slot !== selected) ? BLEND_EVA : 1;
          G.setColor(k, k, k, 1);
          G.draw(spr.image, quad, cx - spr.width / 2, cy - spr.height / 2);
          drawn = true;
        }
      }
      if (!drawn) {
        G.setColor(0.86, 0.88, 0.92, 1);
        G.rectangle("fill", cx - 8, cy - 12, 16, 24);
        G.setColor(1, 1, 1, 1);
      }
    } else {
      const mark = art("question", "question_mark.rgba", 16, 32);
      if (mark) {
        const [qx, qy] = questionCenter(slot);
        G.setColor(1, 1, 1, 1);
        G.draw(mark, qx - 8, qy - 16);
      } else {
        const [cx, cy] = iconCenter(slot);
        FrlgFont.draw("?", cx - 4, cy - 7, { colors: FrlgFont.COLOR.WHITE });
      }
    }
  }
}

// Lua: fame_checker.lua:689
function draw_portrait(person: number): string | null {
  const [img, source] = FameCheckerUi.portrait(person);
  const x = PERSON_X - PORTRAIT / 2, y = PERSON_Y - PORTRAIT / 2;
  const silhouette = FameChecker.pickState(FameCheckerUi._session, person) === PICK().SILHOUETTE;
  if (!img) {
    G.setColor(0.13, 0.16, 0.22, 1);
    G.rectangle("fill", x, y, PORTRAIT, PORTRAIT);
    G.setColor(1, 1, 1, 1);
    FrlgFont.draw(FameCheckerUi.personName(person), x + 2, y + PORTRAIT / 2 - 7,
      { maxWidth: PORTRAIT - 4, colors: FrlgFont.COLOR.WHITE });
    return source;
  }
  // pokefirered/src/fame_checker.c:1374 sSilhouettePalette
  if (silhouette) {
    const PokedexChrome = pokedexChrome();
    if (PokedexChrome && PokedexChrome.drawSilhouette) {
      const [ok] = viaStub(() => PokedexChrome.drawSilhouette(img, x, y));
      if (ok) {
        G.setColor(1, 1, 1, 1);
        return source;
      }
    }
    G.setColor(0.29, 0.29, 0.29, 1);
    G.draw(img, x, y);
    G.setColor(1, 1, 1, 1);
    return source;
  }
  G.setColor(1, 1, 1, 1);
  G.draw(img, x, y);
  return source;
}

// Lua: fame_checker.lua:720
function view(): any {
  let v = FameCheckerUi._view;
  if (v && v.rows === FameCheckerUi._rows
      && v.cursor === FameCheckerUi.cursor && v.scroll === FameCheckerUi.scroll
      && v.mode === FameCheckerUi.mode && v.pickMode === FameCheckerUi.pickMode
      && v.iconCursor === FameCheckerUi.iconCursor
      && v.textPage === FameCheckerUi.textPage
      && v.pages === FameCheckerUi._pages) {
    return v;
  }
  const rows = cachedRows();
  const row = rows[FameCheckerUi.cursor];
  const person = (row && row.person != null) ? row.person : null;
  const msg = FameCheckerUi.messageText();
  let loc: string | null = null, obj: string | null = null;
  if (FameCheckerUi.mode === "flavor" && person != null
      && FameChecker.hasFlavorText(FameCheckerUi._session, person, FameCheckerUi.iconCursor)) {
    [loc, obj] = FameCheckerUi.iconDescription(person, FameCheckerUi.iconCursor);
  }
  v = {
    rows,
    cursor: FameCheckerUi.cursor,
    scroll: FameCheckerUi.scroll,
    mode: FameCheckerUi.mode,
    pickMode: FameCheckerUi.pickMode,
    iconCursor: FameCheckerUi.iconCursor,
    textPage: FameCheckerUi.textPage,
    pages: FameCheckerUi._pages,
    row,
    person,
    icons: person != null ? cachedIcons(person) : null,
    help: FameCheckerUi.helpText(),
    msg: msg ? FrlgFont.wrap(msg, 200) : null,
    loc,
    obj,
    listWin: Window.template(LIST_WIN[1]!, LIST_WIN[2]!, LIST_WIN[3]!, LIST_WIN[4]!),
  };
  FameCheckerUi._view = v;
  return v;
}

// pokefirered/src/fame_checker.c:1588 FC_CreateScrollIndicatorArrowPair
const ARROW_X = 40, ARROW_UP_Y = 26, ARROW_DOWN_Y = 100;

// Lua: fame_checker.lua:764
function draw_scroll_arrows(total: number): void {
  if (total <= MAX_SHOWED) return;
  const BagChrome = bagChrome();
  if (!(BagChrome && BagChrome.drawArrow)) return;
  if (FameCheckerUi.scroll > 0) {
    BagChrome.drawArrow("up", ARROW_X - 8, ARROW_UP_Y - 8);
  }
  if (FameCheckerUi.scroll < total - MAX_SHOWED) {
    BagChrome.drawArrow("down", ARROW_X - 8, ARROW_DOWN_Y - 8);
  }
}

export interface FameCheckerUiModule {
  isMenu: boolean;
  open: boolean;
  mode: string;
  pickMode: boolean;
  cursor: number;
  scroll: number;
  iconCursor: number;
  textPage: number;
  _images: Record<string, Image | false>;
  _pack?: LuaTable | null;
  _packTried?: boolean | null;
  _names: Record<number, string>;
  _pageMemo: Record<string, (string | null)[] | false>;
  _rows: (Row | null)[] | null;
  _icons: Record<number, Icon[]>;
  _view: any;
  _session?: any;
  _onDone?: (() => void) | null;
  _fromBag?: boolean;
  _pages?: (string | null)[] | null;
  background(): Image | null;
  pack(): LuaTable | null | undefined;
  reloadAssets(): void;
  portraitSource(person: unknown): [string | null, string | null];
  portrait(person: unknown): [Image | null, string | null];
  personName(person: unknown): string;
  _personName(p: number): string;
  flavorText(person: unknown, slot: unknown): string | null;
  pickModeText(person: unknown): string | null;
  iconDescription(person: unknown, slot: unknown): [string | null, string | null];
  rows(): (Row | null)[];
  selectedRow(): [Row | null | undefined, (Row | null)[]];
  selectedPerson(): number | null;
  icons(person: unknown): Icon[];
  personHasUnlockedPanels(person: unknown): boolean;
  helpText(): string;
  messageText(): string | null | undefined;
  isOpen(): boolean;
  show(session: any, opts?: any): boolean;
  close(): boolean;
  handleInput(input: any): void;
  draw(): void;
}

export const FameCheckerUi: FameCheckerUiModule = {
  isMenu: true,
  open: false,
  mode: "top",
  pickMode: false,
  cursor: 1,
  scroll: 0,
  iconCursor: 0,
  textPage: 1,
  _images: {},
  _names: {},
  _pageMemo: {},
  _rows: null,
  _icons: {},
  _view: null,

  // Lua: fame_checker.lua:151
  background(): Image | null {
    return art("bg", "bg.rgba", 240, 160);
  },

  // Lua: fame_checker.lua:155
  pack(): LuaTable | null | undefined {
    if (FameCheckerUi._packTried) return FameCheckerUi._pack;
    FameCheckerUi._packTried = true;
    const src = read_bytes(art_root() + "/pack.lua");
    if (!src) return null;
    const [chunk] = luaLoad(src, "@fame_checker/pack.lua");
    if (!chunk) return null;
    let ok = true, pack: any;
    try { pack = chunk(); } catch { ok = false; }
    if (ok && pack != null && typeof pack === "object") FameCheckerUi._pack = pack;
    return FameCheckerUi._pack;
  },

  // Lua: fame_checker.lua:167
  reloadAssets(): void {
    FameCheckerUi._images = {};
    FameCheckerUi._pack = null;
    FameCheckerUi._packTried = null;
    FameCheckerUi._names = {};
    FameCheckerUi._pageMemo = {};
    FameCheckerUi._rows = null;
    FameCheckerUi._icons = {};
    FameCheckerUi._view = null;
  },

  // pokefirered/src/fame_checker.c:1342 CreatePersonPicSprite
  // Lua: fame_checker.lua:179
  portraitSource(person: unknown): [string | null, string | null] {
    const p = tonumber(person);
    if (p == null || TRAINER_PIC[p] == null) return [null, null];
    if (OWN_ART()[p]) return ["art", art_root() + "/" + tostring(p) + ".rgba"];
    return ["trainer", cache_root() + "/trainers/front/" + tostring(TRAINER_PIC[p]) + ".rgba"];
  },

  // Lua: fame_checker.lua:186
  portrait(person: unknown): [Image | null, string | null] {
    const [source, rel] = FameCheckerUi.portraitSource(person);
    if (!source) return [null, null];
    const key = source + rel;
    if (FameCheckerUi._images[key] == null) {
      const bytes = read_bytes(rel!);
      FameCheckerUi._images[key] = (bytes && rgba_to_image(bytes, PORTRAIT, PORTRAIT)) || false;
    }
    const img = FameCheckerUi._images[key] || null;
    if (img) return [img, source];
    return [null, null];
  },

  // pokefirered/src/fame_checker.c:1546 FC_PopulateListMenu
  // Lua: fame_checker.lua:208
  personName(person: unknown): string {
    const p = tonumber(person);
    if (p == null) return "";
    const memo = FameCheckerUi._names[p];
    if (memo) return memo;
    const name = FameCheckerUi._personName(p);
    FameCheckerUi._names[p] = name;
    return name;
  },

  // Lua: fame_checker.lua:218
  _personName(p: number): string {
    const pack = FameCheckerUi.pack();
    const fromPack = pack && pack.listNames && pack.listNames[p];
    if (typeof fromPack === "string" && fromPack !== "") return fromPack;
    const trainerId: number | undefined = FameChecker.TRAINER_IDS[p];
    if (trainerId != null && trainerId < FameChecker.NON_TRAINER_START) {
      // pcall(require, "src.core.game3.scripting.trainers")
      const T: any = Trainers;
      if (T && T.info) {
        let okI = true, info: any;
        try { info = T.info(trainerId); } catch { okI = false; }
        if (okI && info != null && typeof info === "object" && typeof info.name === "string" && info.name !== "") {
          return info.name;
        }
      }
    }
    return nonTrainerName(trainerId) || "";
  },

  // pokefirered/src/fame_checker.c:246 sFameCheckerFlavorTextPointers
  // Lua: fame_checker.lua:269
  flavorText(person: unknown, slot: unknown): string | null {
    const pack = FameCheckerUi.pack();
    const rows = pack && pack.flavorText && pack.flavorText[tonumber(person)!];
    if (rows == null || typeof rows !== "object") return null;
    const text = rows[tonumber(slot)!];
    if (typeof text !== "string" || text === "") return null;
    return text;
  },

  // pokefirered/src/fame_checker.c:209 sFameCheckerNameAndQuotesPointers
  // Lua: fame_checker.lua:279
  pickModeText(person: unknown): string | null {
    const p = tonumber(person);
    if (p == null) return null;
    const pack = FameCheckerUi.pack();
    if (!pack) return null;
    const all = FameChecker.hasUnlockedAllFlavorTexts(FameCheckerUi._session, p);
    const rows = all ? pack.quotes : pack.names;
    const text = (rows != null && typeof rows === "object") ? rows[p] : null;
    if (typeof text !== "string" || text === "") return null;
    return text;
  },

  // pokefirered/src/fame_checker.c:1395 UpdateIconDescriptionBox
  // Lua: fame_checker.lua:292
  iconDescription(person: unknown, slot: unknown): [string | null, string | null] {
    const pack = FameCheckerUi.pack();
    if (!pack) return [null, null];
    const p = tonumber(person)!, s = tonumber(slot)!;
    let loc = pack.originLocation && pack.originLocation[p] && pack.originLocation[p][s];
    let obj = pack.originObject && pack.originObject[p] && pack.originObject[p][s];
    if (typeof loc !== "string") loc = null;
    if (typeof obj !== "string") obj = null;
    return [loc, obj];
  },

  // pokefirered/src/fame_checker.c:1546 FC_PopulateListMenu
  // Lua: fame_checker.lua:306
  rows(): (Row | null)[] {
    const list = FameChecker.unlockedPersons(FameCheckerUi._session);
    const rows: (Row | null)[] = [null];
    for (let i = 1; i <= len(list); i++) {
      rows[i] = { person: list[i], label: FameCheckerUi.personName(list[i]) };
    }
    // pokefirered/src/strings.c:128 gFameCheckerText_Cancel
    rows[len(rows) + 1] = { cancel: true, label: RomText.plain("gFameCheckerText_Cancel") };
    FameCheckerUi._rows = rows;
    FameCheckerUi._view = null;
    return rows;
  },

  // Lua: fame_checker.lua:323
  selectedRow(): [Row | null | undefined, (Row | null)[]] {
    const rows = cachedRows();
    return [rows[FameCheckerUi.cursor], rows];
  },

  // Lua: fame_checker.lua:334
  selectedPerson(): number | null {
    const [row] = FameCheckerUi.selectedRow();
    if (row && row.person != null) return row.person;
    return null;
  },

  // pokefirered/src/fame_checker.c:1099 CreateAllFlavorTextIcons
  // Lua: fame_checker.lua:343
  icons(person: unknown): Icon[] {
    const p = tonumber(person);
    const out: Icon[] = [];
    for (let slot = 0; slot <= NSLOT() - 1; slot++) {
      const unlocked = (p != null && FameChecker.hasFlavorText(FameCheckerUi._session, p, slot)) || false;
      out[slot] = {
        unlocked,
        graphicsId: (unlocked && ICON_GFX[p!] && ICON_GFX[p!]![slot]) || null,
      };
    }
    if (p != null) FameCheckerUi._icons[p] = out;
    return out;
  },

  // Lua: fame_checker.lua:364
  personHasUnlockedPanels(person: unknown): boolean {
    const p = tonumber(person);
    if (p == null) return false;
    for (let slot = 0; slot <= NSLOT() - 1; slot++) {
      if (FameChecker.hasFlavorText(FameCheckerUi._session, p, slot)) return true;
    }
    return false;
  },

  // pokefirered/src/fame_checker.c:1074 PrintUIHelp
  // Lua: fame_checker.lua:374
  helpText(): string {
    if (FameCheckerUi.mode === "flavor") {
      // pokefirered/src/strings.c:1271 gFameCheckerText_FlavorTextUI
      return RomText.plain("gFameCheckerText_FlavorTextUI");
    }
    if (FameCheckerUi.pickMode
        || !FameCheckerUi.personHasUnlockedPanels(FameCheckerUi.selectedPerson())) {
      // pokefirered/src/strings.c:1270 gFameCheckerText_PickScreenUI
      return RomText.plain("gFameCheckerText_PickScreenUI");
    }
    // pokefirered/src/strings.c:1269 gFameCheckerText_MainScreenUI
    return RomText.plain("gFameCheckerText_MainScreenUI");
  },

  // pokefirered/src/fame_checker.c:950 GetPickModeText
  // pokefirered/src/fame_checker.c:1517 PrintCancelDescription
  // pokefirered/src/fame_checker.c:970 PrintSelectedNameInBrightGreen
  // Lua: fame_checker.lua:452
  messageText(): string | null | undefined {
    const [row] = FameCheckerUi.selectedRow();
    if (!row) return null;
    if (FameCheckerUi.mode === "flavor") {
      const pageList = FameCheckerUi._pages;
      if (!pageList) return null;
      return pageList[FameCheckerUi.textPage];
    }
    if (FameCheckerUi.pickMode) {
      if (row.person == null) return null;
      if (FameChecker.pickState(FameCheckerUi._session, row.person) !== PICK().COLORED) {
        return null;
      }
      const text = FameCheckerUi.pickModeText(row.person);
      if (!text) return FameCheckerUi.personName(row.person);
      const pageList = pages(text);
      return pageList ? pageList[1] : null;
    }
    if (row.cancel) {
      return RomText.plain("gFameCheckerText_FameCheckerWillBeClosed");
    }
    return null;
  },

  // Lua: fame_checker.lua:488
  isOpen(): boolean {
    return FameCheckerUi.open;
  },

  // pokefirered/src/fame_checker.c:625 UseFameChecker
  // Lua: fame_checker.lua:493
  show(session: any, opts?: any): boolean {
    opts = opts || {};
    FameCheckerUi._session = session;
    FameCheckerUi._onDone = opts.onDone;
    FameCheckerUi._fromBag = opts.fromBag ? true : false;
    FameCheckerUi._names = {};
    FameCheckerUi._pageMemo = {};
    FameCheckerUi._rows = null;
    FameCheckerUi._icons = {};
    FameCheckerUi._view = null;
    FameCheckerUi.open = true;
    FameCheckerUi.mode = "top";
    FameCheckerUi.pickMode = false;
    FameCheckerUi.cursor = 1;
    FameCheckerUi.scroll = 0;
    FameCheckerUi.iconCursor = 0;
    FameCheckerUi.textPage = 1;
    FameCheckerUi._pages = null;
    clamp_cursor();
    se(SE.SE_M_SWIFT);
    Stack.push("fame_checker", FameCheckerUi, { hideBelow: true, fullscreen: true });
    return true;
  },

  // pokefirered/src/fame_checker.c:1010 Task_StartToCloseFameChecker
  // Lua: fame_checker.lua:518
  close(): boolean {
    if (!FameCheckerUi.open) return false;
    se(SE.SE_M_SWIFT);
    FameCheckerUi.open = false;
    FameCheckerUi.mode = "top";
    FameCheckerUi.pickMode = false;
    FameCheckerUi._pages = null;
    FameCheckerUi._rows = null;
    FameCheckerUi._icons = {};
    FameCheckerUi._view = null;
    Stack.pop("fame_checker");
    const cb = FameCheckerUi._onDone;
    FameCheckerUi._onDone = null;
    FameCheckerUi._session = null;
    if (cb) cb();
    return true;
  },

  // Lua: fame_checker.lua:565
  handleInput(input: any): void {
    if (!FameCheckerUi.open) return;

    if (FameCheckerUi.mode === "flavor") {
      if (input.wasPressed("b")) {
        se(SE.SE_SELECT);
        FameCheckerUi.mode = "top";
        FameCheckerUi._pages = null;
        return;
      }
      if (input.wasPressed("up") || input.wasPressed("down")) {
        moveIconCursor("updown");
      } else if (input.wasPressed("left")) {
        moveIconCursor("left");
      } else if (input.wasPressed("right")) {
        moveIconCursor("right");
      } else if (input.wasPressed("a")) {
        const pageList = FameCheckerUi._pages;
        if (pageList) {
          if (FameCheckerUi.textPage < len(pageList)) {
            FameCheckerUi.textPage = FameCheckerUi.textPage + 1;
          } else {
            FameCheckerUi.textPage = 1;
          }
        }
      }
      return;
    }

    const [row] = FameCheckerUi.selectedRow();
    if (input.wasPressed("select")) {
      if (!FameCheckerUi.pickMode && !FameCheckerUi._fromBag) {
        FameCheckerUi.close();
      }
      return;
    }
    if (input.wasPressed("start")) {
      if (tryExitPickMode()) {
        se(SE.SE_M_LOCK_ON);
      } else if (row && row.person != null) {
        se(SE.SE_M_LOCK_ON);
        FameCheckerUi.pickMode = true;
      }
      return;
    }
    if (input.wasPressed("a")) {
      if (row && row.cancel) {
        FameCheckerUi.close();
      } else if (FameCheckerUi.pickMode) {
        return;
      } else if (row && FameCheckerUi.personHasUnlockedPanels(row.person)) {
        se(SE.SE_SELECT);
        FameCheckerUi.mode = "flavor";
        rebuild_flavor_pages();
      }
      return;
    }
    if (input.wasPressed("b")) {
      if (!tryExitPickMode()) FameCheckerUi.close();
      return;
    }
    if (input.wasPressed("up")) {
      moveListCursor(false);
    } else if (input.wasPressed("down")) {
      moveListCursor(true);
    }
  },

  // Lua: fame_checker.lua:776
  draw(): void {
    if (!FameCheckerUi.open) return;

    const v = view();

    const bg = FameCheckerUi.background();
    if (bg) {
      G.setColor(1, 1, 1, 1);
      G.draw(bg, 0, 0);
    } else {
      G.setColor(0.16, 0.24, 0.38, 1);
      G.rectangle("fill", 0, 0, 240, 160);
      G.setColor(1, 1, 1, 1);
      Window.stdFrame(v.listWin);
    }

    for (let i = 1; i <= MAX_SHOWED; i++) {
      const idx = FameCheckerUi.scroll + i;
      const entry = v.rows[idx];
      if (!entry) break;
      const y = LIST_WIN[2]! * 8 + 4 + (i - 1) * ROW_H;
      if (idx === FameCheckerUi.cursor && FameCheckerUi.mode === "top") {
        Window.cursorPx(LIST_WIN[1]! * 8, y);
      }
      FrlgFont.draw(entry.label, LIST_WIN[1]! * 8 + 8, y,
        {
          maxWidth: LIST_WIN[3]! * 8 - 8,
          colors: idx === FameCheckerUi.cursor ? FrlgFont.COLOR.GREEN : FrlgFont.COLOR.NORMAL,
        });
    }
    draw_scroll_arrows(len(v.rows));

    const person = v.person;
    if (person != null) {
      // pokefirered/src/fame_checker.c:435 sUIBgTemplates
      if (!FameCheckerUi.pickMode) {
        draw_icons(person, FameCheckerUi.mode === "flavor" ? FameCheckerUi.iconCursor : null);
      } else {
        // pokefirered/src/fame_checker.c:669 sFameCheckerTilemap
        const panel = art("pick_panel", "pick_panel.rgba", 240, 160);
        if (!panel) throw new Error("fame_checker/pick_panel.rgba is not in the cache");
        G.setColor(1, 1, 1, 1);
        G.draw(panel, 0, 0);
        draw_portrait(person);
      }
      if (FameCheckerUi.mode === "flavor") {
        const [cx, cy] = selectorCenter(FameCheckerUi.iconCursor);
        const cursorArt = art("cursor", "cursor.rgba", 32, 32);
        if (cursorArt) {
          G.setColor(1, 1, 1, 1);
          G.draw(cursorArt, cx - 16, cy - 16);
        } else {
          G.setColor(1, 0.85, 0.24, 1);
          G.rectangle("line", cx - 16.5, cy - 4.5, 33, 33);
          G.setColor(1, 1, 1, 1);
        }
      }
    }

    // pokefirered/src/fame_checker.c:986 Setup_DrawMsgAndListBoxes
    Window.dialogueFrame();
    if (v.msg) {
      FrlgFont.draw(v.msg, 24, 124,
        { maxWidth: 200, linePitch: 15, colors: FrlgFont.COLOR.NORMAL });
    }

    // pokefirered/src/fame_checker.c:1074 PrintUIHelp
    const PokedexChrome = pokedexChrome();
    let drawnHelp = false;
    if (PokedexChrome && PokedexChrome.drawControlInfo) {
      // a stub pokedex_chrome is the failed lazy require: take the fallback
      [drawnHelp] = viaStub(() => PokedexChrome.drawControlInfo(v.help, HELP_WIN[1]! * 8 + 188, 0));
    }
    if (!drawnHelp) {
      const width = FrlgFont.measure(v.help, { small: true }) || 0;
      FrlgFont.draw(v.help, HELP_WIN[1]! * 8 + 188 - width, 0,
        { small: true, colors: FrlgFont.COLOR.WHITE });
    }

    // pokefirered/src/fame_checker.c:1395 UpdateIconDescriptionBox
    if (v.loc || v.obj) {
      const bx = ICONDESC_WIN[1]! * 8, by = ICONDESC_WIN[2]! * 8;
      if (v.loc) {
        const w = FrlgFont.measure(v.loc, { small: true }) || 0;
        FrlgFont.draw(v.loc, bx + (0x54 - w) / 2, by,
          { small: true, colors: FrlgFont.COLOR.DARK_GRAY });
      }
      if (v.obj) {
        const w = FrlgFont.measure(v.obj, { small: true }) || 0;
        FrlgFont.draw(v.obj, bx + (0x54 - w) / 2, by + 10,
          { small: true, colors: FrlgFont.COLOR.DARK_GRAY });
      }
    }
  },
};

export default FameCheckerUi;
