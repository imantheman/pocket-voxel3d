// Port of gen1recomp src/ui/game3/pc_chrome.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG Pokémon Storage System & PC Chrome helper.
// Direct 1:1 rendering from ROM-extracted assets (pokefirered / FRLG).
// Zero procedural approximations; loads pre-extracted textures from CacheFS.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { byte, format, mod, sub, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { Fs } from "../platform/fs.ts";
import { newImageData, type Image, type Quad } from "../platform/image.ts";
import { luaLoad } from "../platform/luadata.ts";
import { match } from "../platform/lpattern.ts";
import { ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { FrlgFont } from "./frlg_font.ts";
import { Pokemon } from "../core/pokemon.ts";
import { ItemsData } from "../core/items_data.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Dataset } from "../core/dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { Assets } from "../shared/render/Assets.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { RomText } from "../core/rom_text.ts";

// UTF-8 bytes of the Lua source's literals
const MALE_SIGN = "\xE2\x99\x82"; // ♂
const FEMALE_SIGN = "\xE2\x99\x80"; // ♀
const MARK_SYMS = seq("\xE2\x97\x8F", "\xE2\x96\xA0", "\xE2\x96\xB2", "\xE2\x99\xA5"); // ● ■ ▲ ♥

export interface HoldingSource { loc: string; slot: number; box?: number }

export const PcChrome = {
  // Cached texture images (loaded on demand / ensure)
  _initialized: false,
  _game: undefined as string | undefined,
  _manifest: undefined as any,
  _friends: undefined as { key: string; image: Image } | undefined,
  _cursorImg: undefined as Image | undefined,
  _shadowImg: undefined as Image | undefined,
  _arrowImg: undefined as Image | undefined,
  _bgImg: undefined as Image | undefined,
  _frameImg: undefined as Image | undefined,
  _buttonPartyImg: undefined as Image | undefined,
  _buttonCloseImg: undefined as Image | undefined,
  _partyDrawerBgImg: undefined as Image | undefined,
  _partySlotFilledImg: undefined as Image | undefined,
  _partySlotEmptyImg: undefined as Image | undefined,
  _waveformImg: undefined as Image | undefined,
  _waveformQuads: undefined as Record<number, Quad> | undefined,
  _wallpapers: {} as Record<number, Image | undefined>,

  // Lua: pc_chrome.lua:27
  WALLPAPER_NAMES: seq(
    "forest", "city", "desert", "savanna", "crag", "volcano", "snow", "cave",
    "beach", "seafloor", "river", "sky", "stars", "pokecenter", "tiles", "simple",
  ) as LuaTable,

  // Lua: pc_chrome.lua:124
  ensure(): void {
    const game = active_game();
    if (PcChrome._initialized && PcChrome._game === game) return;
    PcChrome._initialized = true;
    PcChrome._game = game;
    PcChrome._wallpapers = {};
    PcChrome._friends = undefined;
    PcChrome._manifest = load_manifest();

    PcChrome._cursorImg = load_texture("cursor.png");
    PcChrome._shadowImg = load_texture("cursor_shadow.png");
    PcChrome._arrowImg = load_texture("box_scroll_arrow.png");
    PcChrome._bgImg = load_texture("scrolling_bg.png");
    PcChrome._frameImg = load_texture("interface_frame.png");
    PcChrome._buttonPartyImg = load_texture("button_party.png");
    PcChrome._buttonCloseImg = load_texture("button_close.png");
    PcChrome._partyDrawerBgImg = load_texture("party_drawer_bg.png");
    PcChrome._partySlotFilledImg = load_texture("party_slot_filled.png");
    PcChrome._partySlotEmptyImg = load_texture("party_slot_empty.png");
    PcChrome._waveformImg = load_texture("waveform.png");
    PcChrome._waveformQuads = undefined;

    for (const [id, name] of ipairs<string>(PcChrome.wallpaperNames())) {
      PcChrome._wallpapers[id] = load_texture("wallpapers/" + name + ".png");
    }
  },

  // Lua: pc_chrome.lua:151
  wallpaperNames(): LuaTable {
    const m = PcChrome._manifest;
    if (m && m.wallpaperOrder != null && typeof m.wallpaperOrder === "object") return m.wallpaperOrder;
    return PcChrome.WALLPAPER_NAMES;
  },

  // Lua: pc_chrome.lua:157
  hasFriends(): boolean {
    PcChrome.ensure();
    return PcChrome._manifest != null && PcChrome._manifest.friends != null;
  },

  // pokeemerald/src/pokemon_storage_system.c:9661
  // Lua: pc_chrome.lua:163
  WALDA_DEFAULT: { colors: seq(0x7B35, 0x6186), iconId: 0, patternId: 0 } as any,

  // pokeemerald/src/pokemon_storage_system.c:5388
  // Lua: pc_chrome.lua:171
  friendsWallpaper(walda?: any): Image | undefined {
    PcChrome.ensure();
    const m = PcChrome._manifest;
    if (!(m && m.friends)) return undefined;
    walda = walda ?? PcChrome.WALDA_DEFAULT;
    const colors = walda.colors ?? PcChrome.WALDA_DEFAULT.colors;
    const key = format("%d:%d:%d:%d", tonumber(walda.patternId) ?? 0, tonumber(walda.iconId) ?? 0,
      tonumber(colors[1]) ?? 0, tonumber(colors[2]) ?? 0);
    if (PcChrome._friends && PcChrome._friends.key === key) return PcChrome._friends.image;
    const parent = match(m.friends, "^(.*)/[^/]+$") as string | undefined;
    if (parent == null) return undefined;
    const dir = "data/generated/gba/pokemon/storage/" + parent + "/";
    const src = read_bytes("data/generated/gba/pokemon/storage/" + m.friends);
    // load(src, "@friends", "t", {})() -- an error there propagates, as in the Lua
    const fm: any = src ? luaLoad(src, "@friends")[0]!() : undefined;
    if (!fm) return undefined;
    const pat = fm.patterns[tonumber(walda.patternId) ?? 0] ?? fm.patterns[0];
    if (!pat) return undefined;
    let tiles = read_bytes(dir + pat.tiles) ?? "";
    const iconName = fm.icons[tonumber(walda.iconId) ?? 0] ?? fm.icons[0];
    if (!iconName) return undefined;
    const icon = read_bytes(dir + iconName) ?? "";
    const off = fm.iconTileOffset;
    tiles = sub(tiles, 1, off) + icon + sub(tiles, off + icon.length + 1);
    const map = read_bytes(dir + pat.map) ?? "";
    const pal: Record<number, any> = {};
    for (let i = 0; i <= 31; i++) pal[i] = pat.palette[i + 1];
    pal[1] = colors[1]; pal[2] = colors[2]; pal[17] = colors[1]; pal[18] = colors[2];
    const W = fm.width * 8, H = fm.height * 8;
    const img = newImageData(W, H);
    for (let ty = 0; ty <= fm.height - 1; ty++) {
      for (let tx = 0; tx <= fm.width - 1; tx++) {
        const mi = (ty * fm.width + tx) * 2 + 1;
        const e = (byte(map, mi) ?? 0) + (byte(map, mi + 1) ?? 0) * 256;
        const tile = mod(e, 1024);
        const hf = mod(Math.floor(e / 1024), 2) === 1, vf = mod(Math.floor(e / 2048), 2) === 1;
        let bank = mod(Math.floor(e / 4096), 16) - 1;
        if (bank < 0) bank = 0;
        for (let y = 0; y <= 7; y++) {
          for (let x = 0; x <= 7; x++) {
            const sx = hf ? 7 - x : x, sy = vf ? 7 - y : y;
            const b = byte(tiles, tile * 32 + sy * 4 + Math.floor(sx / 2) + 1) ?? 0;
            const idx = mod(sx, 2) === 0 ? mod(b, 16) : Math.floor(b / 16);
            if (idx !== 0) {
              const [r, g, bb] = bgr(pal[bank * 16 + idx]);
              img.setPixel(tx * 8 + x, ty * 8 + y, r, g, bb, 1);
            }
          }
        }
      }
    }
    const image = G.newImage(img);
    image.setFilter("nearest", "nearest");
    PcChrome._friends = { key, image };
    return image;
  },

  /** Draw authentic tiled scrolling background (BG3). */
  // Lua: pc_chrome.lua:228
  drawBackground(): void {
    PcChrome.ensure();
    G.setColor(1, 1, 1, 1);
    if (PcChrome._bgImg) {
      const [bw, bh] = PcChrome._bgImg.getDimensions();
      for (let bx = 0; bx <= 240; bx += bw) {
        for (let by = 0; by <= 160; by += bh) {
          G.draw(PcChrome._bgImg, bx, by);
        }
      }
    } else {
      G.setColor(248 / 255, 216 / 255, 208 / 255, 1);
      G.rectangle("fill", 0, 0, 240, 160);
    }
    G.setColor(1, 1, 1, 1);
  },

  // Lua: pc_chrome.lua:258
  drawWaveforms(active: boolean, frame?: number): void {
    PcChrome.ensure();
    if (!PcChrome._waveformImg) return;

    // Left waveform: center (8, 9) -> top-left (0, 5)
    // Right waveform: center (71, 9) -> top-left (63, 5)
    let leftFrameIdx = 0;
    let rightFrameIdx = 4;
    if (active) {
      const animSeq = seq(0, 1, 2, 3);
      const rightSeq = seq(4, 5, 6, 5);
      const idx = mod(Math.floor((frame ?? 0) / 4), 4) + 1;
      leftFrameIdx = animSeq[idx]!;
      rightFrameIdx = rightSeq[idx]!;
    }

    const leftQuad = waveform_quad(PcChrome._waveformImg, leftFrameIdx);
    const rightQuad = waveform_quad(PcChrome._waveformImg, rightFrameIdx);

    G.setColor(1, 1, 1, 1);
    G.draw(PcChrome._waveformImg, leftQuad, 0, 5);
    G.draw(PcChrome._waveformImg, rightQuad, 63, 5);
  },

  /** Draw the 160×144 ROM wallpaper (BG2) at (80, 16). */
  // Lua: pc_chrome.lua:283
  drawWallpaper(wallpaperIdIn: unknown, walda?: any): void {
    PcChrome.ensure();
    const count = len(PcChrome.wallpaperNames());
    let wpImg: Image | undefined;
    if (tonumber(wallpaperIdIn) === count + 1 && PcChrome.hasFriends()) {
      wpImg = PcChrome.friendsWallpaper(walda);
    } else {
      const wallpaperId = Math.max(1, Math.min(count, tonumber(wallpaperIdIn) ?? 1));
      wpImg = PcChrome._wallpapers[wallpaperId] ?? PcChrome._wallpapers[1];
    }
    if (wpImg) {
      G.setColor(1, 1, 1, 1);
      G.draw(wpImg, 80, 16);
    }
  },

  /** Draw the ROM interface frame (BG1) at (0, 0). */
  // Lua: pc_chrome.lua:300
  drawInterfaceFrame(): void {
    PcChrome.ensure();
    if (PcChrome._frameImg) {
      G.setColor(1, 1, 1, 1);
      G.draw(PcChrome._frameImg, 0, 0);
    }
  },

  /** Draw Left TV Monitor & Lower stats card contents. */
  // Lua: pc_chrome.lua:309
  drawLeftDataPanel(hoveredMon: any, hoverFrame?: number): void {
    PcChrome.ensure();

    // Draw Waveforms (animated if hovering mon, idle flatline if not)
    PcChrome.drawWaveforms(hoveredMon != null, hoverFrame);

    if (!hoveredMon) return;

    // 1. Front Sprite in TV Screen (X: 10..73, Y: 19..80, W: 64, H: 61)
    // pokefirered/src/pokemon_storage_system_data.c:1034, :1057 MON_DATA_SPECIES_OR_EGG
    const sp = Pokemon.speciesOrEgg(hoveredMon);
    const sprite = Pokemon.monFrontPic(hoveredMon);
    if (sprite && sprite.image) {
      G.setColor(1, 1, 1, 1);
      const [sw, sh] = sprite.image.getDimensions();
      const scale = Math.min(54 / sw, 54 / sh);
      const sx = 10 + Math.floor((64 - sw * scale) / 2);
      const sy = 19 + Math.floor((61 - sh * scale) / 2);
      G.draw(sprite.image, sx, sy, 0, scale, scale);
    }

    // 2. Lower Stats Card Text & Info (X: 0..80, Y: 88..160)
    // Matches pret FRLG PrintDisplayMonInfo (Window 0: left=0, top=11 / Y=88)
    const isEgg = Pokemon.isEgg(hoveredMon);
    const spName = (!isEgg && sp != null ? Pokemon.name(sp) : null) ?? "----";
    let nick = hoveredMon.nickname;
    if (!nick || nick === "") {
      nick = (hoveredMon.name && hoveredMon.name !== "" ? hoveredMon.name : null) ?? spName;
    }
    if (!nick || nick === "") {
      nick = spName;
    }
    const lvl = hoveredMon.level ?? 5;
    const gender = hoveredMon.gender
      ?? (hoveredMon.personality != null ? ((mod(hoveredMon.personality, 256) < 127) ? "F" : "M") : null);
    // pokefirered/src/pokemon_storage_system_data.c:1091: an egg shows only
    // gText_EggNickname; the species, gender/level and item lines stay blank.
    if (isEgg) nick = RomText.plain("gText_EggNickname");

    // Line 1: Nickname or Species Name (FONT_NORMAL, Y: 88)
    FrlgFont.draw(FrlgFont.truncate(nick, 10), 6, 88, {
      small: false,
      colors: FrlgFont.COLOR.WHITE,
    });

    if (!isEgg) {
      // Line 2: /Species Name (FONT_NORMAL, Y: 102)
      FrlgFont.draw("/" + FrlgFont.truncate(spName, 10), 6, 102, {
        small: false,
        colors: FrlgFont.COLOR.WHITE,
      });

      // Line 3: Gender & Level (FONT_NORMAL, Y: 116)
      // src/pokemon_storage_system_data.c:1148
      if (gender === "M" || gender === "male") {
        FrlgFont.draw(MALE_SIGN, 6, 116, { small: false, colors: FrlgFont.COLOR.MALE });
        FrlgFont.draw("{LV_2}" + tostring(lvl), 18, 116, { small: false, colors: FrlgFont.COLOR.WHITE });
      } else if (gender === "F" || gender === "female") {
        FrlgFont.draw(FEMALE_SIGN, 6, 116, { small: false, colors: FrlgFont.COLOR.FEMALE });
        FrlgFont.draw("{LV_2}" + tostring(lvl), 18, 116, { small: false, colors: FrlgFont.COLOR.WHITE });
      } else {
        FrlgFont.draw("{LV_2}" + tostring(lvl), 6, 116, { small: false, colors: FrlgFont.COLOR.WHITE });
      }

      // Line 4: Held Item Name (if holding an item) (FONT_SMALL, Y: 132)
      const held = hoveredMon.heldItem ?? hoveredMon.item;
      if (held != null && held !== false && held > 0) {
        const heldName = ItemsData.displayName(held);
        if (heldName && heldName !== "" && heldName !== "NONE") {
          FrlgFont.draw(FrlgFont.truncate(heldName, 10), 6, 132, {
            small: true,
            colors: FrlgFont.COLOR.WHITE,
          });
        }
      }
    }

    // Line 5: 4 Markings ● ■ ▲ ♥ (pret markingComboSprite centered at X: 40, Y: 148)
    const marks = hoveredMon.markings ?? 0;
    for (let m = 1; m <= 4; m++) {
      const bitMask = Math.pow(2, m - 1);
      const hasMark = (typeof marks === "number") && (mod(marks, bitMask * 2) >= bitMask);
      const mx = 23 + (m - 1) * 9;
      if (hasMark) {
        FrlgFont.draw(MARK_SYMS[m], mx, 146, {
          small: true,
          colors: { fg: [1, 1, 1, 1], shadow: [40 / 255, 48 / 255, 60 / 255, 1], bg: undefined },
        });
      } else {
        FrlgFont.draw(MARK_SYMS[m], mx, 146, {
          small: true,
          colors: { fg: [72 / 255, 80 / 255, 96 / 255, 0.7], shadow: [40 / 255, 44 / 255, 56 / 255, 0.5], bg: undefined },
        });
      }
    }

    G.setColor(1, 1, 1, 1);
  },

  /** Draw Top Right Buttons: PARTY POKéMON (X: 80, Y: 0) and CLOSE BOX (X: 168, Y: 0). */
  // Lua: pc_chrome.lua:409
  drawTopButtons(_activeButton?: unknown): void {
    PcChrome.ensure();
    G.setColor(1, 1, 1, 1);

    if (PcChrome._buttonPartyImg) {
      G.draw(PcChrome._buttonPartyImg, 80, 0);
    }

    if (PcChrome._buttonCloseImg) {
      G.draw(PcChrome._buttonCloseImg, 168, 0);
    }
    G.setColor(1, 1, 1, 1);
  },

  /** Draw Box Title Banner: Left Arrow (88, 22), Box Name Text (centered at X: 160, Y: 20), Right Arrow (224, 22). */
  // Lua: pc_chrome.lua:424
  drawBoxHeader(boxName: unknown, boxNum: unknown, _isHovered?: unknown): void {
    PcChrome.ensure();

    // Left Arrow ◀ (X: 88, Y: 22, Frame 0: quad 0, 0, 8, 16)
    if (PcChrome._arrowImg) {
      const leftQuad = G.newQuad(0, 0, 8, 16, ...PcChrome._arrowImg.getDimensions());
      G.setColor(1, 1, 1, 1);
      G.draw(PcChrome._arrowImg, leftQuad, 88, 22);
    }

    // Box Name Text (drawn centered on the ROM wallpaper's capsule)
    // Default names are stored in English ("BOX 3", see Storage.new); show those
    // translated and leave the names the player typed alone.
    const num = tonumber(boxNum) ?? 1;
    const nameStr = (boxName == null || boxName === format("BOX %d", num))
      ? Strings("BOX %d", num)
      : tostring(boxName);
    const nw = FrlgFont.measure(nameStr);
    const tx = Math.floor(160 - nw / 2);
    FrlgFont.draw(nameStr, tx, 20, {
      colors: FrlgFont.COLOR.WHITE,
    });

    // Right Arrow ▶ (X: 224, Y: 22, Frame 1: quad 0, 16, 8, 16)
    if (PcChrome._arrowImg) {
      const rightQuad = G.newQuad(0, 16, 8, 16, ...PcChrome._arrowImg.getDimensions());
      G.setColor(1, 1, 1, 1);
      G.draw(PcChrome._arrowImg, rightQuad, 224, 22);
    }
    G.setColor(1, 1, 1, 1);
  },

  /** Return authentic GBA hand cursor coordinates for party drawer slots (1..6 for mons, 7 for CANCEL). */
  // Lua: pc_chrome.lua:457
  getPartyCursorCoords(partyCursorIn?: number): [number, number] {
    const partyCursor = partyCursorIn ?? 1;
    if (partyCursor === 1) {
      return [104, 52];
    } else if (partyCursor >= 2 && partyCursor <= 6) {
      return [152, (partyCursor - 2) * 24 + 4];
    } else { // CANCEL button (7)
      return [152, 132];
    }
  },

  /** Draw the authentic Party Drawer overlay (96x160 panel, slot backgrounds, and Pokémon icons). */
  // Lua: pc_chrome.lua:469
  drawPartyDrawer(partyIn: LuaTable, partyCursor: number, hoverFrame: number, holdingSource?: HoldingSource | null): void {
    PcChrome.ensure();
    G.setColor(1, 1, 1, 1);

    // 1. Base drawer background at (80, 0)
    if (PcChrome._partyDrawerBgImg) {
      G.draw(PcChrome._partyDrawerBgImg, 80, 0);
    }

    // 2. Party Slots 2..6 (X: 136, Y: 8 + (p - 2) * 24)
    const party = partyIn ?? seq();
    for (let p = 2; p <= 6; p++) {
      const isPickedUp = (holdingSource && holdingSource.loc === "party" && holdingSource.slot === p);
      const pMon = (!isPickedUp) && party[p];
      const sx = 136;
      const sy = 8 + (p - 2) * 24;
      if (pMon) {
        if (PcChrome._partySlotFilledImg) {
          G.draw(PcChrome._partySlotFilledImg, sx, sy);
        }
      } else {
        if (PcChrome._partySlotEmptyImg) {
          G.draw(PcChrome._partySlotEmptyImg, sx, sy);
        }
      }
    }

    // 3. Party Pokémon Animated Mini-Icons
    // Slot 1 (Lead): pret Center (104, 64) -> Top-Left (88, 48)
    const isLeadPickedUp = (holdingSource && holdingSource.loc === "party" && holdingSource.slot === 1);
    const leadMon = (!isLeadPickedUp) && party[1];
    if (leadMon) {
      const icon: any = Pokemon.monIcon(leadMon);
      if (icon && icon.image) {
        const isHovered = (partyCursor === 1);
        const bounce = (isHovered && (mod(hoverFrame, 2) === 1)) ? -2 : 0;
        const f = (isHovered && (mod(hoverFrame, 2) === 1)) ? 1 : 0;
        const q = icon.quads && (icon.quads[f] ?? icon.quads[0]);
        if (q) {
          G.draw(icon.image, q, 88, 48 + bounce);
        } else {
          G.draw(icon.image, 88, 48 + bounce);
        }
      }
    }

    // Slots 2..6: pret Center (152, 16 + (p - 2) * 24) -> Top-Left (136, (p - 2) * 24)
    for (let p = 2; p <= 6; p++) {
      const isPickedUp = (holdingSource && holdingSource.loc === "party" && holdingSource.slot === p);
      const pMon = (!isPickedUp) && party[p];
      if (pMon) {
        const icon: any = Pokemon.monIcon(pMon);
        if (icon && icon.image) {
          const isHovered = (partyCursor === p);
          const bounce = (isHovered && (mod(hoverFrame, 2) === 1)) ? -2 : 0;
          const f = (isHovered && (mod(hoverFrame, 2) === 1)) ? 1 : 0;
          const q = icon.quads && (icon.quads[f] ?? icon.quads[0]);
          const iy = (p - 2) * 24;
          if (q) {
            G.draw(icon.image, q, 136, iy + bounce);
          } else {
            G.draw(icon.image, 136, iy + bounce);
          }
        }
      }
    }
    G.setColor(1, 1, 1, 1);
  },

  /** Draw Hand Cursor with authentic GBA positioning, optional drop shadow, and vertical flip. */
  // Lua: pc_chrome.lua:539
  drawHandCursor(x: number, y: number, stateIn?: string, showShadow?: boolean, vFlip?: boolean): void {
    PcChrome.ensure();
    const state = stateIn ?? "idle";

    // 1. Draw Oval Drop Shadow (GBA 16x16 sprite centered at x, y + 20)
    // Only visible when hovering over an empty box slot
    if (showShadow && PcChrome._shadowImg) {
      G.setColor(1, 1, 1, 1);
      G.draw(PcChrome._shadowImg, x - 8, y + 12);
    }

    // 2. Draw Hand Cursor Sprite (GBA 32x32 sprite centered at x, y)
    if (PcChrome._cursorImg) {
      let quadY = 0;
      if (state === "grab") quadY = 64;
      else if (state === "holding") quadY = 96;
      const quad = G.newQuad(0, quadY, 32, 32, ...PcChrome._cursorImg.getDimensions());
      G.setColor(1, 1, 1, 1);
      const sy = vFlip ? -1 : 1;
      G.draw(PcChrome._cursorImg, quad, x, y, 0, 1, sy, 16, 16);
    }
    G.setColor(1, 1, 1, 1);
  },
};

// Lua: pc_chrome.lua:46
function read_bytes(rel: string): string | undefined {
  // pcall(require, "src.core.game3.dataset"): the module is always there.
  if (Dataset && Dataset.mountExtractRoots) {
    Dataset.mountExtractRoots();
  }
  if (Dataset && Dataset.cache) {
    const cacheObj = Dataset.cache();
    if (cacheObj && cacheObj.read) {
      const d = cacheObj.read(rel);
      if (typeof d === "string" && d.length > 0) return d;
    }
  }
  // pcall(require, "src.import.CacheFs"): the module is always there.
  if (CacheFs && CacheFs.readActive) {
    const d = CacheFs.readActive(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  {
    let d: string | undefined;
    try { d = Fs.read(rel); } catch { d = undefined; }
    if (typeof d === "string" && d.length > 0) return d;
  }
  // NOT FAITHFUL: the io.open(rel) fallback (a file beside the executable)
  // has no 3DS equivalent.
  return undefined;
}

// Lua: pc_chrome.lua:76
function load_texture(name: string): Image | undefined {
  const candidates = seq(
    "pokemon/storage/" + name,
    "data/generated/gba/pokemon/storage/" + name,
  );
  // pcall(require, "src.render.Assets"): the module is always there.
  for (const [, path] of ipairs<string>(candidates)) {
    if (Assets && Assets.image) {
      let img: Image | undefined;
      try { img = Assets.image(path); } catch { img = undefined; }
      if (img) {
        if (img.setFilter) img.setFilter("nearest", "nearest");
        return img;
      }
    }
    const bytes = read_bytes(path);
    if (bytes && bytes.length > 0) {
      let img: Image | undefined;
      try {
        const fd = Fs.newFileData(bytes, name);
        const id = newImageData(fd);
        const image = G.newImage(id);
        if (image.setFilter) image.setFilter("nearest", "nearest");
        img = image;
      } catch { img = undefined; }
      if (img) return img;
    }
    {
      let img: Image | undefined;
      try { img = G.newImage(path); } catch { img = undefined; }
      if (img) {
        if (img.setFilter) img.setFilter("nearest", "nearest");
        return img;
      }
    }
  }
  return undefined;
}

// Lua: pc_chrome.lua:112
function load_manifest(): any {
  const src = read_bytes("data/generated/gba/pokemon/storage/manifest.lua");
  const chunk = src ? luaLoad(src, "@storage/manifest.lua")[0] : undefined;
  let ok: boolean, t: unknown;
  try { t = (chunk ?? ((): unknown => null))(); ok = true; } catch { ok = false; }
  return ok && t != null && typeof t === "object" ? t : undefined;
}

// Lua: pc_chrome.lua:119
function active_game(): string | undefined {
  // pcall(require, "src.core.GameVersion"): the module is always there.
  return GameVersion.get ? GameVersion.get() : undefined;
}

// Lua: pc_chrome.lua:165
function bgr(cIn: unknown): [number, number, number] {
  const c = tonumber(cIn) ?? 0;
  return [mod(c, 32) / 31, mod(Math.floor(c / 32), 32) / 31, mod(Math.floor(c / 1024), 32) / 31];
}

/** Draw animated waveforms beside PKMN DATA header */
// Lua: pc_chrome.lua:246
function waveform_quad(img: Image, frameIdx: number): Quad {
  let quads = PcChrome._waveformQuads;
  if (!quads) { quads = {}; PcChrome._waveformQuads = quads; }
  let q = quads[frameIdx + 1];
  if (!q) {
    const [iw, ih] = img.getDimensions();
    q = G.newQuad(0, frameIdx * 8, 16, 8, iw, ih);
    quads[frameIdx + 1] = q;
  }
  return q;
}

export default PcChrome;
