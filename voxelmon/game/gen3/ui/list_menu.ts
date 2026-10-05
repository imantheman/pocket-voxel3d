// Port of gen1recomp src/ui/game3/list_menu.lua (GPLv3 + additional terms; see LICENSE.md).
// pret ListMenu (pokefirered/src/list_menu.c): a scrolling item list in a window.

import { mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type Quad } from "../platform/image.ts";
import { luaLoad } from "../platform/luadata.ts";
import { ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { Display } from "../core/display.ts";
import { Dataset } from "../core/dataset.ts";
import { Audio } from "../core/audio.ts";
import { SE } from "../core/se_ids.ts";
import { BagChrome } from "./bag_chrome.ts";
import { Window, type TemplateLike } from "./window.ts";
import { FrlgFont, type Colors } from "./frlg_font.ts";

// Display.TILE, read when used (no top-level reads of imports: the cycle)
function tile(): number { return Display.TILE; }

export interface ListItem {
  label?: unknown; colors?: Colors; locked?: boolean; disabled?: boolean;
  print?: (item: ListItem, px: number, py: number, selected: boolean, index: number) => void;
  [k: string]: unknown;
}
export interface ListInput { wasPressed(k: string): boolean; isDown?(k: string): boolean }
export interface ListMenuOpts {
  template?: TemplateLike; frame?: string; items?: (ListItem | null)[]; maxShowed?: unknown; itemX?: unknown;
  cursorX?: unknown; upTextY?: unknown; rowHeight?: unknown; letterSpacing?: unknown; scrollMultiple?: string;
  sound?: boolean; cursorKind?: unknown; arrows?: boolean;
  onSelect?: (item: ListItem, index: number) => void; onCancel?: () => void; onMove?: (item: ListItem | undefined, index: number) => void;
}
interface ArrowArt { image: Image; frames: Record<string, { quad: Quad; bounce: LuaTable }>; w: number; h: number }

// Lua: list_menu.lua:23
function playSe(name: string): void {
  const se = (SE as unknown as Record<string, unknown>)[name];
  if (Audio && Audio.playSe && se != null) {
    try { Audio.playSe(se); } catch { /* pcall */ }
  }
}

const HELD_KEYS = seq("up", "down", "left", "right", "l", "r") as string[];

// Lua: list_menu.lua:275
function lockImage(path: string): Image {
  const cached = ListMenu._locks[path];
  if (cached) return cached;
  const image = G.newImage(path);
  image.setFilter("nearest", "nearest");
  ListMenu._locks[path] = image;
  return image;
}

// Lua: list_menu.lua:315
function sine(pos: number): number {
  const v = Math.sin(mod(pos, 256) * Math.PI * 2 / 256) * 256;
  return v < 0 ? Math.ceil(v - 0.5) : Math.floor(v + 0.5);
}

export class ListMenu {
  static CHROME = "data/generated/gba/chrome/";
  static LOCK_NORMAL = "assets/game3/lock8.png";
  // pokefirered/src/main.c:286
  static REPEAT_START = 40;
  static REPEAT_CONTINUE = 5;
  static LOCK_W = 10;

  // pokefirered/src/union_room.c:4072
  // built on first read: FrlgFont may not be initialised when this class is
  // defined (the import cycle; no top-level reads of imports)
  private static colorWhite: Colors | undefined;
  static get COLOR_WHITE(): Colors {
    return (ListMenu.colorWhite ??= { fg: FrlgFont.STDPAL[1], shadow: FrlgFont.STDPAL[3], bg: FrlgFont.STDPAL[0] });
  }

  static _arrows: ArrowArt | undefined = undefined;
  static _locks: Record<string, Image> = {};

  static playSe = playSe;

  template!: TemplateLike;
  frame!: string;
  items!: (ListItem | null)[];
  maxShowed!: number;
  itemX!: number;
  cursorX!: number;
  upTextY!: number;
  rowHeight!: number;
  letterSpacing!: number;
  scrollMultiple!: string;
  sound!: boolean;
  cursorKind!: number;
  arrows!: boolean;
  onSelect: ListMenuOpts["onSelect"];
  onCancel: ListMenuOpts["onCancel"];
  onMove: ListMenuOpts["onMove"];
  scroll = 0;
  row = 0;
  frames = 0;
  _held: string | undefined = undefined;
  _heldFrames = 0;

  // Lua: list_menu.lua:31
  static new(opts?: ListMenuOpts): ListMenu {
    opts = opts || {};
    const self = new ListMenu();
    self.template = opts.template || Window.template(0, 0, 8, 2);
    self.frame = opts.frame || "std";
    self.items = opts.items || seq();
    self.maxShowed = Math.max(1, Math.floor(tonumber(opts.maxShowed) ?? len(self.items)));
    self.itemX = tonumber(opts.itemX) ?? 8;
    self.cursorX = tonumber(opts.cursorX) ?? 0;
    self.upTextY = tonumber(opts.upTextY) ?? 1;
    self.rowHeight = tonumber(opts.rowHeight) ?? 16;
    self.letterSpacing = tonumber(opts.letterSpacing) ?? 0;
    self.scrollMultiple = opts.scrollMultiple || "none";
    self.sound = opts.sound !== false;
    self.cursorKind = tonumber(opts.cursorKind) ?? 0;
    self.arrows = opts.arrows !== false;
    self.onSelect = opts.onSelect;
    self.onCancel = opts.onCancel;
    self.onMove = opts.onMove;
    self.scroll = 0;
    self.row = 0;
    self.frames = 0;
    self._held = undefined;
    self._heldFrames = 0;
    return self;
  }

  // Lua: list_menu.lua:58
  shown(): number {
    return Math.max(0, Math.min(this.maxShowed, len(this.items)));
  }

  // Lua: list_menu.lua:62
  clamp(): void {
    const n = len(this.items);
    const shown = this.shown();
    if (n === 0) {
      this.scroll = 0; this.row = 0;
      return;
    }
    if (this.scroll > n - shown) this.scroll = Math.max(0, n - shown);
    if (this.scroll < 0) this.scroll = 0;
    if (this.row > shown - 1) this.row = Math.max(0, shown - 1);
    if (this.row < 0) this.row = 0;
  }

  // Lua: list_menu.lua:75
  setItems(items: (ListItem | null)[] | undefined, keepCursor?: boolean): void {
    this.items = items || seq();
    if (!keepCursor) {
      this.scroll = 0; this.row = 0;
    }
    this.clamp();
  }

  /** -> [item, index] */
  // Lua: list_menu.lua:83
  selected(): [ListItem | undefined, number] {
    const index = this.scroll + this.row + 1;
    return [this.items[index] ?? undefined, index];
  }

  // Lua: list_menu.lua:88
  setSelected(indexIn: unknown): void {
    const n = len(this.items);
    const shown = this.shown();
    const index = Math.max(1, Math.min(n, Math.floor(tonumber(indexIn) ?? 1)));
    if (n === 0) return;
    const scroll = Math.max(0, Math.min(index - 1, n - shown));
    this.scroll = scroll;
    this.row = index - 1 - scroll;
  }

  // pokefirered/src/list_menu.c:438
  // Lua: list_menu.lua:99
  step(down: boolean): number {
    const n = len(this.items);
    const shown = this.shown();
    if (shown === 0) return 0;
    const row = this.row, scroll = this.scroll;
    if (!down) {
      const newRow = shown === 1 ? 0 : (shown - (Math.floor(shown / 2) + mod(shown, 2)) - 1);
      if (scroll === 0) {
        if (row > 0) {
          this.row = row - 1;
          return 1;
        }
        return 0;
      }
      if (row > newRow) {
        this.row = row - 1;
        return 1;
      }
      this.row = newRow;
      this.scroll = scroll - 1;
      return 2;
    }
    const newRow = shown === 1 ? 0 : (Math.floor(shown / 2) + mod(shown, 2));
    if (scroll === n - shown) {
      if (row < shown - 1) {
        this.row = row + 1;
        return 1;
      }
      return 0;
    }
    if (row < newRow) {
      this.row = row + 1;
      return 1;
    }
    this.row = newRow;
    this.scroll = scroll + 1;
    return 2;
  }

  // pokefirered/src/list_menu.c:558
  // Lua: list_menu.lua:139
  changeSelection(count: number | undefined, down: boolean): boolean {
    let changed = false;
    for (let k = 1; k <= Math.max(1, count || 1); k++) {
      if (this.step(down) !== 0) changed = true;
    }
    if (changed) {
      // pokefirered/src/list_menu.c:620
      if (this.sound) playSe("SE_SELECT");
      if (this.onMove) {
        const [item, index] = this.selected();
        this.onMove(item, index);
      }
    }
    return changed;
  }

  // Lua: list_menu.lua:157
  trackHeld(input: ListInput): void {
    let key: string | undefined;
    if (input && input.isDown) {
      for (let i = 1; i <= 6; i++) {
        const k = HELD_KEYS[i]!;
        let ok = true, down: unknown;
        try { down = input.isDown(k); } catch { ok = false; }
        if (ok && truthy(down)) {
          key = k;
          break;
        }
      }
    }
    const fresh = key !== undefined && input.wasPressed(key);
    if (key !== this._held || fresh) {
      this._held = key;
      this._heldFrames = 0;
    } else if (key !== undefined) {
      this._heldFrames = this._heldFrames + 1;
    }
  }

  // Lua: list_menu.lua:177
  repeated(input: ListInput, key: string): boolean {
    if (input.wasPressed(key)) return true;
    return this._held === key && this._heldFrames >= ListMenu.REPEAT_START
      && mod(this._heldFrames - ListMenu.REPEAT_START, ListMenu.REPEAT_CONTINUE) === 0;
  }

  // pokefirered/src/list_menu.c:166
  // Lua: list_menu.lua:184
  handleInput(input?: ListInput): string | undefined {
    if (!input) return undefined;
    this.trackHeld(input);
    if (input.wasPressed("a")) {
      const [item, index] = this.selected();
      if (!item) return undefined;
      if (item.disabled) {
        // pokefirered/src/union_room.c:1234
        playSe("SE_WALL_HIT");
        return undefined;
      }
      if (this.onSelect) this.onSelect(item, index);
      return "select";
    }
    if (input.wasPressed("b")) {
      if (this.onCancel) this.onCancel();
      return "cancel";
    }
    if (this.repeated(input, "up")) {
      return this.changeSelection(1, false) ? "move" : undefined;
    }
    if (this.repeated(input, "down")) {
      return this.changeSelection(1, true) ? "move" : undefined;
    }
    let left = false, right = false;
    if (this.scrollMultiple === "dpad") {
      [left, right] = [this.repeated(input, "left"), this.repeated(input, "right")];
    } else if (this.scrollMultiple === "lr") {
      [left, right] = [this.repeated(input, "l"), this.repeated(input, "r")];
    }
    if (left) return this.changeSelection(this.maxShowed, false) ? "move" : undefined;
    if (right) return this.changeSelection(this.maxShowed, true) ? "move" : undefined;
    return undefined;
  }

  // Lua: list_menu.lua:219
  update(_dt?: number): void {
    this.frames = this.frames + 1;
  }

  // Lua: list_menu.lua:223
  static itemColors(item: ListItem): Colors {
    if (item.locked || item.disabled) return ListMenu.COLOR_WHITE;
    return item.colors || FrlgFont.COLOR.NORMAL!;
  }

  // Lua: list_menu.lua:228
  static printItem(item: ListItem, px: number, py: number, letterSpacing?: number): void {
    let x = px;
    if (item.locked) {
      ListMenu.drawLock(px, py + 3);
      x = px + ListMenu.LOCK_W;
    }
    FrlgFont.draw(tostring(item.label != null ? item.label : ""), x, py, {
      colors: ListMenu.itemColors(item),
      letterSpacing,
    });
  }

  // Lua: list_menu.lua:240
  rowY(i: number): number {
    return (this.template.top ?? this.template.tilemapTop)! * tile() + i * this.rowHeight + this.upTextY;
  }

  // Lua: list_menu.lua:244
  draw(): void {
    const tpl = this.template;
    if (this.frame === "std") {
      Window.stdFrame(tpl);
    } else if (this.frame === "fixed") {
      Window.fixedStdFrame(tpl);
    }
    const ox = (tpl.left ?? tpl.tilemapLeft)! * tile();
    const shown = this.shown();
    for (let i = 0; i <= shown - 1; i++) {
      const index = this.scroll + i + 1;
      const item = this.items[index];
      if (item) {
        const px = ox + this.itemX, py = this.rowY(i);
        if (item.print) {
          item.print(item, px, py, i === this.row, index);
        } else {
          ListMenu.printItem(item, px, py, this.letterSpacing);
        }
      }
    }
    if (this.cursorKind === 0 && shown > 0) {
      Window.cursorPx(ox + this.cursorX, this.rowY(this.row));
    }
    const n = len(this.items);
    if (this.arrows && n > shown) {
      ListMenu.drawScrollArrows(tpl, this.scroll > 0, this.scroll < n - shown, this.frames);
    }
  }

  // Lua: list_menu.lua:284
  static drawLock(px: number, py: number, path?: string): void {
    G.setColor(1, 1, 1, 1);
    G.draw(lockImage(path || ListMenu.LOCK_NORMAL), px, py);
  }

  // pokefirered/src/menu_indicators.c:323
  // Lua: list_menu.lua:291
  static loadArrows(): ArrowArt {
    if (ListMenu._arrows) return ListMenu._arrows;
    const cache = Dataset.cache();
    const src = cache.read(ListMenu.CHROME + "manifest.lua");
    if (typeof src !== "string") throw new Error("chrome/manifest.lua missing from the cache");
    const [chunk, err] = luaLoad(src, "@chrome/manifest.lua");
    if (!chunk) throw new Error(err);
    const manifest = chunk() as LuaTable;
    const entry = manifest.scroll_arrows;
    if (!truthy(entry)) throw new Error("chrome manifest has no scroll_arrows");
    const w = tonumber(entry.width)!, h = tonumber(entry.height)!;
    const fw = tonumber(entry.frame_w) ?? 16, fh = tonumber(entry.frame_h) ?? 16;
    const rgba = cache.read(ListMenu.CHROME + entry.file);
    if (!(typeof rgba === "string" && rgba.length === w * h * 4)) throw new Error("chrome/scroll_arrows.rgba missing");
    const image = G.newImage(newImageData(w, h, "rgba8", rgba));
    image.setFilter("nearest", "nearest");
    const frames: ArrowArt["frames"] = {};
    for (const [i, name] of ipairs<string>(entry.order)) {
      frames[name] = {
        quad: G.newQuad(0, (i - 1) * fh, fw, fh, w, h),
        bounce: entry.bounce[i],
      };
    }
    ListMenu._arrows = { image, frames, w: fw, h: fh };
    return ListMenu._arrows;
  }

  /** -> [dx, dy] */
  // pokefirered/src/menu_indicators.c:270
  // Lua: list_menu.lua:321
  static bounce(entry: LuaTable | undefined, t: unknown): [number, number] {
    if (!entry) return [0, 0];
    const pos = mod(Math.floor(tonumber(t) ?? 0) * entry.frequency, 256);
    let v = sine(pos) * entry.multiplier / 256;
    v = v < 0 ? Math.ceil(v) : Math.floor(v);
    if (entry.bounceDir === 1) return [0, v];
    return [v, 0];
  }

  // Lua: list_menu.lua:330
  static drawArrow(dir: string, cx: number, cy: number, t?: number): void {
    let drawn = false;
    let art: ArrowArt | undefined;
    try { art = ListMenu.loadArrows(); } catch { art = undefined; }
    if (art && typeof art === "object") {
      const frame = art.frames ? art.frames[dir] : undefined;
      if (frame) {
        const [dx, dy] = ListMenu.bounce(frame.bounce, t);
        G.setColor(1, 1, 1, 1);
        G.draw(art.image, frame.quad, cx - art.w / 2 + dx, cy - art.h / 2 + dy);
        drawn = true;
      }
    }
    // NOT FAITHFUL: Emerald only -- the src.ui.game3.rse.bag_chrome fallback
    // (an RSE profile's bag arrows) is not ported; its require fails here
    if (!drawn) {
      if (BagChrome && BagChrome.drawArrow) {
        let okD = true;
        try { BagChrome.drawArrow(dir, cx - 8, cy - 8); } catch { okD = false; }
        if (okD) drawn = true;
      }
    }
    if (!drawn) {
      const dy = (dir === "up" ? -1 : 1) * Math.floor(Math.sin(mod(t ?? 0, 256) * Math.PI * 2 / 32) * 2 + 0.5);
      const glyph = (dir === "up" ? FrlgFont.CHAR_UP_ARROW : undefined) ?? (dir === "down" ? FrlgFont.CHAR_DOWN_ARROW : undefined) ?? FrlgFont.CHAR_SELECTOR_ARROW;
      FrlgFont.drawGlyph(glyph, cx - 4, cy - 4 + dy, { colors: FrlgFont.COLOR.NORMAL });
    }
  }

  // Lua: list_menu.lua:364
  static drawScrollArrows(template: TemplateLike, showUp: boolean, showDown: boolean, t?: number): void {
    const left = (template.left ?? template.tilemapLeft)!;
    const top = (template.top ?? template.tilemapTop)!;
    const w = (template.w ?? template.width)!;
    const h = (template.h ?? template.height)!;
    const cx = (left + w / 2) * tile();
    if (showUp) ListMenu.drawArrow("up", cx, top * tile(), t);
    if (showDown) ListMenu.drawArrow("down", cx, (top + h) * tile(), t);
  }
}

export default ListMenu;
