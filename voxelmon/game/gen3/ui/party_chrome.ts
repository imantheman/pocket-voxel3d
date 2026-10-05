// Port of gen1recomp src/ui/game3/party_chrome.lua (GPLv3 + additional terms; see LICENSE.md).
// Party menu chrome from firered GBA extract (ROM-baked BG, slots, balls).

import { tonumber, tostring } from "../../../import/gen3/lua.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { PartyChromeExtract } from "../../../import/gen3/party_chrome_extract.ts";
import { Display } from "../core/display.ts";
import { FrlgFont } from "./frlg_font.ts";
import { RomText } from "../core/rom_text.ts";
import { Profile } from "../core/profile.ts";
import { Dataset } from "../core/dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { G } from "../platform/graphics.ts";
import { Fs } from "../platform/fs.ts";
import { newImageData, type Image, type ImageData, type Quad } from "../platform/image.ts";
import { luaLoad } from "../platform/luadata.ts";
import { find, gsub } from "../platform/lpattern.ts";
import { ipairs, seq } from "../platform/lt.ts";

interface ChromeCache { read(rel: string): string | undefined }

/** A cached chrome image: { image, w, h } (plus the no-HP quads blit_no_hp adds). */
export interface SlotEntry { image: Image; w: number; h: number; noHpQuads?: (Quad | null)[] }
export interface BallEntry {
  image: Image; w: number; h: number; frameH: number; frameCount: number;
  quads: Record<number, Quad>;
}
export interface StatusEntry { image: Image; quads: Record<number, Quad>; frameW: number; frameH: number }

export const PartyChrome = {
  _cache: null as ChromeCache | null | undefined,
  _bg: null as SlotEntry | null,
  _balls: null as BallEntry | null,
  _slotMain: null as SlotEntry | null,
  _slotWide: null as SlotEntry | null,
  _slotMainSel: null as SlotEntry | null,
  _slotWideSel: null as SlotEntry | null,
  _slotEmpty: null as SlotEntry | null,
  _slotMulti: null as Record<string, SlotEntry> | null,
  _cancelBtn: null as SlotEntry | null,
  _cancelBtnSel: null as SlotEntry | null,
  _confirmBtn: null as SlotEntry | null,
  _confirmBtnSel: null as SlotEntry | null,
  _status: null as StatusEntry | null,
  _manifest: null as any,
  _logged: false,

  // Lua: party_chrome.lua:140
  install(cache?: any): void {
    if (!cache || !cache.read) {
      // pcall(require, "src.core.game3.dataset"): the module is always there.
      if (Dataset && Dataset.cache) {
        cache = Dataset.cache();
      }
    }
    PartyChrome._cache = cache;
    PartyChrome._bg = null;
    PartyChrome._balls = null;
    PartyChrome._slotMain = null;
    PartyChrome._slotWide = null;
    PartyChrome._slotMainSel = null;
    PartyChrome._slotWideSel = null;
    PartyChrome._slotEmpty = null;
    PartyChrome._slotMulti = null;
    PartyChrome._cancelBtn = null;
    PartyChrome._cancelBtnSel = null;
    PartyChrome._confirmBtn = null;
    PartyChrome._confirmBtnSel = null;
    PartyChrome._status = null;
    PartyChrome._manifest = load_lua(party_root() + "/manifest.lua");
    PartyChrome._logged = false;
    if (PartyChrome._manifest) {
      log("party chrome manifest ready");
    } else {
      log("party chrome missing \xE2\x80\x94 re-import FireRed ROM");
    }
  },

  // Lua: party_chrome.lua:346
  ready(): boolean {
    return PartyChromeExtract.ready(PartyChrome._cache as any, cache_root());
  },

  // Lua: party_chrome.lua:350
  drawBg(): void {
    const W = Display.W || 240, H = Display.H || 160;
    const bg = ensureBg();
    G.setColor(1, 1, 1, 1);
    if (bg && bg.image) {
      G.draw(bg.image, 0, 0);
      return;
    }
    G.setColor(0.31, 0.69, 0.47, 1);
    G.rectangle("fill", 0, 0, W, H);
    G.setColor(1, 1, 1, 1);
  },

  /** Draw pret slot panel at window tile coords. kind: main|wide|empty */
  // Lua: party_chrome.lua:392
  drawSlot(kind: string, tileLeft: number, tileTop: number, selected?: unknown, hideHp?: unknown, multi?: unknown): void {
    const slot = ensureSlot(kind === "main" ? "main" : (kind === "empty" ? "empty" : "wide"), selected, multi);
    const T = Display.TILE || 8;
    const px = tileLeft * T, py = tileTop * T;
    G.setColor(1, 1, 1, 1);
    if (slot && slot.image) {
      G.draw(slot.image, px, py);
      if (hideHp && kind !== "empty") {
        blit_no_hp(slot, kind, px, py);
      }
      return;
    }
    const pw = (kind === "main") ? 80 : 144;
    const ph = (kind === "main") ? 56 : 24;
    if (selected) {
      G.setColor(0.48, 0.84, 0.94, 1);
      G.rectangle("fill", px, py, pw, ph);
      G.setColor(1.0, 0.45, 0.19, 1);
      G.setLineWidth(2);
      G.rectangle("line", px + 1, py + 1, pw - 2, ph - 2);
      G.setLineWidth(1);
    } else {
      G.setColor(0.40, 0.72, 0.88, 1);
      G.rectangle("fill", px, py, pw, ph);
    }
    G.setColor(1, 1, 1, 1);
  },

  // Lua: party_chrome.lua:420
  ballEntry(): BallEntry | null {
    return ensureBalls();
  },

  // Lua: party_chrome.lua:424
  statusEntry(frameIn: unknown): [Image | null, Quad | null] {
    const frame = tonumber(frameIn);
    if (frame == null || frame < 1) return [null, null];
    const st = ensureStatus();
    if (!st) return [null, null];
    return [st.image, st.quads[frame - 1] ?? null];
  },

  // Lua: party_chrome.lua:432
  drawBall(px: number, py: number, frameIn?: unknown): void {
    const balls = ensureBalls();
    if (!balls) return;
    let frame = tonumber(frameIn) ?? 0;
    if (frame < 0) frame = 0;
    if (frame >= balls.frameCount) frame = balls.frameCount - 1;
    const q = balls.quads[frame];
    G.setColor(1, 1, 1, 1);
    if (q) {
      G.draw(balls.image, q, px, py);
    } else {
      G.draw(balls.image, px, py);
    }
  },

  // Lua: party_chrome.lua:447
  drawStatus(px: number, py: number, frameIn: unknown): void {
    const frame = tonumber(frameIn);
    if (frame == null || frame < 1) return;
    const st = ensureStatus();
    if (!st) return;
    const q = st.quads[frame - 1];
    if (!q) return;
    G.setColor(1, 1, 1, 1);
    G.draw(st.image, q, px, py);
  },

  // Lua: party_chrome.lua:458
  statusFrameFor(status: unknown): number {
    if (status == null || status === false || status === 0 || status === "OK" || status === "ok" || status === "none") {
      return 0;
    }
    const s = tostring(status).toLowerCase();
    if (find(s, "poison") || s === "psn" || find(s, "toxic") || s === "tox" || s === "1") return 1;
    if (find(s, "paraly") || s === "par" || s === "prz" || s === "2") return 2;
    if (find(s, "sleep") || s === "slp" || s === "3") return 3;
    if (find(s, "freeze") || find(s, "frozen") || s === "frz" || s === "4") return 4;
    if (find(s, "burn") || s === "brn" || s === "5") return 5;
    if (find(s, "pokerus") || s === "pkrs" || s === "6") return 6;
    if (find(s, "faint") || s === "fnt" || s === "7") return 7;
    return 1;
  },

  // Lua: party_chrome.lua:480
  drawCancelButton(pxIn?: number | null, pyIn?: number | null, selected?: unknown): void {
    const px = pxIn ?? 184;
    const py = pyIn ?? 136;
    const btn = ensureCancelButton(selected);
    G.setColor(1, 1, 1, 1);
    if (btn && btn.image) {
      G.draw(btn.image, px, py);
    }
    PartyChrome.drawBall(px - 2, py - 4, selected ? 1 : 0);
    const b = buttonText();
    if (b) {
      // pokeemerald/src/party_menu.c:2131
      const t = RomText.plain(b.cancel);
      const w = FrlgFont.measure(t, { small: true });
      FrlgFont.draw(t, px + 8 + Math.floor((48 - w) / 2) + 3, py + 1, { colors: FrlgFont.COLOR.PARTY, small: true });
      return;
    }
    // pokefirered/src/party_menu.c:2154
    FrlgFont.draw(RomText.plain("gFameCheckerText_Cancel"), px + 20, py + 1, {
      colors: FrlgFont.COLOR.PARTY,
      small: true,
    });
  },

  // Lua: party_chrome.lua:504
  drawConfirmButton(pxIn?: number | null, pyIn?: number | null, selected?: unknown): void {
    const px = pxIn ?? 184;
    const py = pyIn ?? 128;
    const btn = ensureConfirmButton(selected);
    G.setColor(1, 1, 1, 1);
    if (btn && btn.image) {
      G.draw(btn.image, px, py);
    }
    PartyChrome.drawBall(px - 2, py - 4, selected ? 1 : 0);
    const b = buttonText();
    if (b) {
      // pokeemerald/src/party_menu.c:2114
      const t = RomText.plain(b.confirm);
      const w = FrlgFont.measure(t, { small: true });
      FrlgFont.draw(t, px + 8 + Math.floor((48 - w) / 2), py + 1, { colors: FrlgFont.COLOR.PARTY, small: true });
      return;
    }
    // pokefirered/src/party_menu.c:2138
    FrlgFont.draw(RomText.plain("gText_PartyMenu_OK"), px + 25, py + 2, {
      colors: FrlgFont.COLOR.PARTY,
      small: true,
    });
  },
};

// Lua: party_chrome.lua:25
function cache_root(): string {
  return Extract.CACHE_ROOT || "data/generated/gba";
}

// Lua: party_chrome.lua:29
function party_root(): string {
  return cache_root() + "/pokemon/party";
}

// Lua: party_chrome.lua:33
function log(msg: unknown): void {
  if (PartyChrome._logged) return;
  PartyChrome._logged = true;
  console.log("[game3/party_chrome] " + tostring(msg));
}

// Lua: party_chrome.lua:39
function read_bytes(rel: string): string | undefined {
  const cache = PartyChrome._cache;
  if (cache && cache.read) {
    const d = cache.read(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  // Standalone Game3 has no mod.cache — use firered CacheFs / Dataset.
  // pcall(require, "src.core.game3.dataset"): the module is always there.
  if (Dataset && Dataset.cache) {
    const d = Dataset.cache().read(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  // pcall(require, "src.import.CacheFs"): the module is always there.
  if (CacheFs && CacheFs.readActive) {
    const d = CacheFs.readActive(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  {
    let d = Fs.read(rel);
    if (typeof d === "string" && d.length > 0) return d;
    const alt = "data/generated/gba/" + gsub(rel, "^data/generated/gba/", "")[0];
    d = Fs.read(alt);
    if (typeof d === "string" && d.length > 0) return d;
  }
  // NOT FAITHFUL: the io.open(rel / "data/generated/gba/"..rel) fallback
  // (a file beside the executable) has no 3DS equivalent.
  return undefined;
}

// Lua: party_chrome.lua:78
function load_lua(rel: string): any {
  const src = read_bytes(rel);
  if (!src) return null;
  const [chunk] = luaLoad(src, "@" + rel);
  if (!chunk) return null;
  try {
    return chunk();
  } catch {
    return null;
  }
}

// Lua: party_chrome.lua:88
function rgba_to_image(rgba: string | undefined, w: number, h: number): Image | null {
  if (!rgba || rgba.length < w * h * 4) return null;
  let imageData: ImageData | undefined;
  try { imageData = newImageData(w, h, "rgba8", rgba); } catch { imageData = undefined; }
  if (!imageData) {
    imageData = newImageData(w, h);
    let i = 0;
    for (let y = 0; y <= h - 1; y++) {
      for (let x = 0; x <= w - 1; x++) {
        imageData.setPixel(x, y,
          (rgba.charCodeAt(i) || 0) / 255,
          (rgba.charCodeAt(i + 1) || 0) / 255,
          (rgba.charCodeAt(i + 2) || 0) / 255,
          (rgba.charCodeAt(i + 3) || 0) / 255);
        i += 4;
      }
    }
  }
  const image = G.newImage(imageData);
  if (image.setFilter) image.setFilter("nearest", "nearest");
  return image;
}

// Lua: party_chrome.lua:111
function load_status_png(): Image | null {
  const candidates = seq(
    party_root() + "/status_icons.png",
    "data/generated/gba/pokemon/summary/status_icons.png",
  );
  for (const [, rel] of ipairs<string>(candidates)) {
    const bytes = read_bytes(rel);
    if (bytes) {
      let img: Image | null = null;
      try {
        const fd = Fs.newFileData(bytes, "status_icons.png");
        const id = newImageData(fd);
        const image = G.newImage(id);
        if (image.setFilter) image.setFilter("nearest", "nearest");
        img = image;
      } catch { img = null; }
      if (img) return img;
    }
    if (Fs.getInfo(rel)) {
      let img: Image | null = null;
      try { img = G.newImage(rel); } catch { img = null; }
      if (img) {
        if (img.setFilter) img.setFilter("nearest", "nearest");
        return img;
      }
    }
  }
  return null;
}

// Lua: party_chrome.lua:170
function man(): any {
  if (!PartyChrome._manifest) {
    PartyChrome._manifest = load_lua(party_root() + "/manifest.lua");
  }
  return PartyChrome._manifest || {};
}

// Lua: party_chrome.lua:177
function ensureCancelButton(selected: unknown): SlotEntry | null {
  if (selected) {
    if (PartyChrome._cancelBtnSel) return PartyChrome._cancelBtnSel;
    const m = man();
    const w = m.cancelButtonW ?? 56, h = m.cancelButtonH ?? 16;
    const img = rgba_to_image(read_bytes(party_root() + "/cancel_button_selected.rgba"), w, h);
    if (img) {
      PartyChrome._cancelBtnSel = { image: img, w, h };
      return PartyChrome._cancelBtnSel;
    }
  } else {
    if (PartyChrome._cancelBtn) return PartyChrome._cancelBtn;
    const m = man();
    const w = m.cancelButtonW ?? 56, h = m.cancelButtonH ?? 16;
    const img = rgba_to_image(read_bytes(party_root() + "/cancel_button.rgba"), w, h);
    if (img) {
      PartyChrome._cancelBtn = { image: img, w, h };
      return PartyChrome._cancelBtn;
    }
  }
  return null;
}

// Lua: party_chrome.lua:200
function ensureConfirmButton(selected: unknown): SlotEntry | null {
  if (selected) {
    if (PartyChrome._confirmBtnSel) return PartyChrome._confirmBtnSel;
    const m = man();
    const w = m.cancelButtonW ?? 56, h = m.cancelButtonH ?? 16;
    const img = rgba_to_image(read_bytes(party_root() + "/confirm_button_selected.rgba"), w, h);
    if (img) {
      PartyChrome._confirmBtnSel = { image: img, w, h };
      return PartyChrome._confirmBtnSel;
    }
  } else {
    if (PartyChrome._confirmBtn) return PartyChrome._confirmBtn;
    const m = man();
    const w = m.cancelButtonW ?? 56, h = m.cancelButtonH ?? 16;
    const img = rgba_to_image(read_bytes(party_root() + "/confirm_button.rgba"), w, h);
    if (img) {
      PartyChrome._confirmBtn = { image: img, w, h };
      return PartyChrome._confirmBtn;
    }
  }
  return null;
}

// Lua: party_chrome.lua:223
function ensureBg(): SlotEntry | null {
  if (PartyChrome._bg) return PartyChrome._bg;
  const m = man();
  const w = m.width ?? 240, h = m.height ?? 160;
  const img = rgba_to_image(read_bytes(party_root() + "/bg.rgba"), w, h);
  if (img) {
    PartyChrome._bg = { image: img, w, h };
    log("party chrome BG+slots ready");
  } else {
    log("party chrome missing \xE2\x80\x94 re-import FireRed ROM");
  }
  return PartyChrome._bg;
}

// Lua: party_chrome.lua:237
function ensureMultiSlot(kind: string, selected: unknown): SlotEntry | null {
  const key = (kind === "main" ? "main" : "wide") + (selected ? "_selected" : "");
  PartyChrome._slotMulti = PartyChrome._slotMulti || {};
  if (PartyChrome._slotMulti[key]) return PartyChrome._slotMulti[key]!;
  const m = man();
  let file: string, w: number, h: number;
  if (kind === "main") {
    file = selected ? "slot_main_multi_selected.rgba" : "slot_main_multi.rgba";
    w = m.slotMainW ?? 80; h = m.slotMainH ?? 56;
  } else {
    file = selected ? "slot_wide_multi_selected.rgba" : "slot_wide_multi.rgba";
    w = m.slotWideW ?? 144; h = m.slotWideH ?? 24;
  }
  const img = rgba_to_image(read_bytes(party_root() + "/" + file), w, h);
  if (!img) return null;
  const entry: SlotEntry = { image: img, w, h };
  PartyChrome._slotMulti[key] = entry;
  return entry;
}

// Lua: party_chrome.lua:257
function ensureSlot(kind: string, selected: unknown, multi: unknown): SlotEntry | null {
  if (multi && kind !== "empty") {
    return ensureMultiSlot(kind, selected);
  }
  if (selected) {
    if (kind === "main" && PartyChrome._slotMainSel) return PartyChrome._slotMainSel;
    if (kind === "wide" && PartyChrome._slotWideSel) return PartyChrome._slotWideSel;
  } else {
    if (kind === "main" && PartyChrome._slotMain) return PartyChrome._slotMain;
    if (kind === "wide" && PartyChrome._slotWide) return PartyChrome._slotWide;
    if (kind === "empty" && PartyChrome._slotEmpty) return PartyChrome._slotEmpty;
  }
  const m = man();
  let file: string, w: number, h: number;
  if (kind === "main") {
    file = selected ? "slot_main_selected.rgba" : "slot_main.rgba";
    w = m.slotMainW ?? 80; h = m.slotMainH ?? 56;
  } else if (kind === "empty") {
    file = "slot_wide_empty.rgba";
    w = m.slotWideW ?? 144; h = m.slotWideH ?? 24;
  } else {
    file = selected ? "slot_wide_selected.rgba" : "slot_wide.rgba";
    w = m.slotWideW ?? 144; h = m.slotWideH ?? 24;
  }
  const img = rgba_to_image(read_bytes(party_root() + "/" + file), w, h);
  if (!img) return null;
  const entry: SlotEntry = { image: img, w, h };
  if (selected) {
    if (kind === "main") PartyChrome._slotMainSel = entry;
    else PartyChrome._slotWideSel = entry;
  } else {
    if (kind === "main") PartyChrome._slotMain = entry;
    else if (kind === "empty") PartyChrome._slotEmpty = entry;
    else PartyChrome._slotWide = entry;
  }
  return entry;
}

// Lua: party_chrome.lua:295
function ensureBalls(): BallEntry | null {
  if (PartyChrome._balls) return PartyChrome._balls;
  const m = man();
  const w: number = m.ballW ?? 32;
  const sheetH: number = m.ballSheetH ?? 64;
  const frames: number = m.ballFrames ?? 2;
  const img = rgba_to_image(read_bytes(party_root() + "/status_balls.rgba"), w, sheetH);
  if (!img) return null;
  const fh = Math.floor(sheetH / frames);
  const quads: Record<number, Quad> = {};
  for (let i = 0; i <= frames - 1; i++) {
    quads[i] = G.newQuad(0, i * fh, w, fh, w, sheetH);
  }
  PartyChrome._balls = {
    image: img, w, h: fh, frameH: fh, frameCount: frames, quads,
  };
  return PartyChrome._balls;
}

// Lua: party_chrome.lua:314
function ensureStatus(): StatusEntry | null {
  if (PartyChrome._status) return PartyChrome._status;
  const raw = read_bytes(party_root() + "/status_icons.rgba")
    || read_bytes(cache_root() + "/pokemon/summary/status_icons.rgba");
  let img: Image | null = null;
  let fw = 32, fh = 8;
  const quads: Record<number, Quad> = {};
  if (raw && raw.length >= 32 * 64 * 4) {
    img = rgba_to_image(raw, 32, 64);
    if (img) {
      for (let i = 0; i <= 7; i++) {
        quads[i] = G.newQuad(0, i * 8, 32, 8, 32, 64);
      }
    }
  }
  if (!img) {
    img = load_status_png();
    if (img) {
      const [iw, ih] = img.getDimensions();
      fw = (iw >= 32 ? 32 : 16); fh = 8;
      const cols = Math.max(1, Math.floor(iw / fw));
      for (let i = 0; i <= cols - 1; i++) {
        quads[i] = G.newQuad(i * fw, 0, fw, fh, iw, ih);
      }
    }
  }
  if (!img) return null;
  const entry: StatusEntry = { image: img, quads, frameW: fw, frameH: fh };
  PartyChrome._status = entry;
  return entry;
}

// Lua: party_chrome.lua:363
const NO_HP_MAIN = seq(
  seq(8, 40, 64, 8, 8, 32),
  seq(72, 40, 8, 8, 72, 32),
  seq(8, 8, 64, 1, 8, 33),
  seq(8, 8, 3, 1, 72, 33),
);

// Lua: party_chrome.lua:370
const NO_HP_WIDE = seq(
  seq(8, 8, 64, 8, 72, 8),
  seq(8, 8, 2, 8, 136, 8),
);

// pokefirered/src/party_menu.c:2187
// Lua: party_chrome.lua:376
function blit_no_hp(slot: SlotEntry, kind: string, px: number, py: number): void {
  const plan = (kind === "main") ? NO_HP_MAIN : NO_HP_WIDE;
  if (kind === "main" && (slot.w !== 80 || slot.h !== 56)) return;
  if (kind !== "main" && (slot.w !== 144 || slot.h !== 24)) return;
  slot.noHpQuads = slot.noHpQuads || [null];
  for (const [i, r] of ipairs<number[]>(plan)) {
    let q = slot.noHpQuads[i];
    if (!q) {
      q = G.newQuad(r[1]!, r[2]!, r[3]!, r[4]!, slot.w, slot.h);
      slot.noHpQuads[i] = q;
    }
    G.draw(slot.image, q, px + r[5]!, py + r[6]!);
  }
}

// Lua: party_chrome.lua:473
function buttonText(): any {
  // pcall(require, "src.core.game3.profile"): the module is always there.
  const row = Profile.forSession(null);
  const party = row && typeof row.ui === "object" && row.ui != null ? row.ui.party : null;
  return party ? (party.buttons ?? null) : null;
}

export default PartyChrome;
