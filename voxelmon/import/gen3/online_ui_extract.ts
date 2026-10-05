// Port of gen1recomp src/import/gba/online_ui_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/menu_indicators.c:258, src/minigame_countdown.c:213, src/union_room_player_avatar.c:33
// Manifest rows are built as the Lua builds them (sequences are 0-based
// arrays) so AssetPack.serialize writes the same text.

import { Versions } from "./versions.ts";
import { AssetPack, type FrameSpec } from "./asset_pack.ts";
import { format } from "./lua.ts";
import type { Bytes, PalBank } from "./bg_bake.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

type Write = (path: string, data: string) => void;

const SCREEN_W = 240, SCREEN_H = 160;
const T = 8;

// Lua: online_ui_extract.lua:16
function need(buf: Bytes, n: number, what: string): Bytes {
  if (AssetPack.len(buf) < n) {
    throw new Error(format("online_ui: %s decompressed to %d bytes, want %d", what, AssetPack.len(buf), n));
  }
  return buf;
}

// Lua: online_ui_extract.lua:23
function sprite(key: string, fw: number, fh: number, frames: number, extra?: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {
    file: key + ".rgba", kind: "sprite", width: fw, height: fh * frames,
    frame_w: fw, frame_h: fh, frames,
  };
  for (const k of Object.keys(extra ?? {})) row[k] = extra![k];
  return row;
}

// Lua: online_ui_extract.lua:69 (src/minigame_countdown.c:216, src/pokemon_jump.c:457, src/digit_obj_util.c:67)
function linkArt(rom: Rom, cache: Cache, root: string): void {
  const dir = root + "/" + OnlineUiExtract.LINK_SUB;
  const cdBank = AssetPack.banks(rom, Versions.MG_COUNTDOWN_PAL, 1)[0];
  const cd = need(AssetPack.lz(rom, Versions.MG_COUNTDOWN_GFX), 0xe00, "minigame countdown");
  cache.write(dir + "/minigame_countdown_numbers.rgba", AssetPack.strip(cd, cdBank, 0, 16, 32, 32, 3));
  cache.write(dir + "/minigame_countdown_start.rgba", AssetPack.frames(cd, cdBank,
    [{ tile: 48 }, { tile: 80 }], 64, 32));
  cache.write(dir + "/minigame_countdown.pal", AssetPack.palRgb({ 0: cdBank }, 0, 1));

  const stBank = AssetPack.banks(rom, Versions.MG_321START_PAL, 1)[0];
  const st = need(AssetPack.lz(rom, Versions.MG_321START_GFX), 0xc00, "321start");
  cache.write(dir + "/countdown_321.rgba", AssetPack.strip(st, stBank, 0, 16, 32, 32, 6));
  cache.write(dir + "/countdown_321.pal", AssetPack.palRgb({ 0: stBank }, 0, 1));

  const dgBank = AssetPack.banks(rom, Versions.MG_DIGITS_PAL, 1)[0];
  const dg = need(AssetPack.lz(rom, Versions.MG_DIGITS_GFX), 11 * 32, "minigame digits");
  cache.write(dir + "/minigame_digits.rgba", AssetPack.strip(dg, dgBank, 0, 1, 8, 8, 11));
  cache.write(dir + "/minigame_digits.pal", AssetPack.palRgb({ 0: dgBank }, 0, 1));

  cache.write(dir + "/manifest.lua", AssetPack.serialize({
    format_version: OnlineUiExtract.FORMAT_VERSION,
    minigame_countdown_numbers: sprite("minigame_countdown_numbers", 32, 32, 3, {
      order: [3, 2, 1], palette: "minigame_countdown.pal",
    }),
    minigame_countdown_start: sprite("minigame_countdown_start", 64, 32, 2, {
      order: ["left", "right"], palette: "minigame_countdown.pal",
    }),
    countdown_321: sprite("countdown_321", 32, 32, 6, {
      order: ["three", "two", "one", "start_mid", "start_left", "start_right"], palette: "countdown_321.pal",
    }),
    minigame_digits: sprite("minigame_digits", 8, 8, 11, { palette: "minigame_digits.pal" }),
  }));
}

export const OnlineUiExtract = {
  FORMAT_VERSION: 1,
  LINK_SUB: "link",
  AVATARS: "union_room/avatars.lua",
  STAMP_COUNT: 8,

  // Lua: online_ui_extract.lua:33 (src/menu_indicators.c:99-121)
  listChrome(rom: Rom, write: Write, dir: string): Record<string, unknown> {
    const bank = AssetPack.banks(rom, Versions.SCROLL_ARROW_PAL, 1)[0];
    const arrows = need(AssetPack.lz(rom, Versions.SCROLL_ARROW_GFX), 0x100, "scroll arrows");
    const arrowFrames: FrameSpec[] = [{ tile: 0 }, { tile: 0, hflip: true }, { tile: 4 }, { tile: 4, vflip: true }];
    write(dir + "/scroll_arrows.rgba", AssetPack.frames(arrows, bank, arrowFrames, 16, 16));
    const cursor = need(AssetPack.lz(rom, Versions.RED_ARROW_CURSOR_GFX), 0x80, "red arrow cursor");
    write(dir + "/red_arrow_cursor.rgba", AssetPack.frame(cursor, bank, 0, 16, 16));
    const outline = need(AssetPack.lz(rom, Versions.SELECTOR_OUTLINE_GFX), 0x100, "selector outline");
    write(dir + "/selector_outline.rgba", AssetPack.strip(outline, bank, 0, 1, 8, 8, 8));
    write(dir + "/red_arrow.pal", AssetPack.palRgb({ 0: bank }, 0, 1));

    const bounce: Record<string, number>[] = [];
    for (let i = 0; i <= 3; i++) {
      const off = Versions.SCROLL_INDICATOR_TEMPLATES + i * 4;
      const b0 = rom.get(off);
      bounce[i] = {
        animNum: b0 % 16, bounceDir: Math.floor(b0 / 16),
        multiplier: rom.get(off + 1), frequency: AssetPack.read(rom, off + 2, "s16"),
      };
    }
    return {
      scroll_arrows: sprite("scroll_arrows", 16, 16, 4, {
        order: ["left", "right", "up", "down"], palette: "red_arrow.pal", bounce,
      }),
      red_arrow_cursor: sprite("red_arrow_cursor", 16, 16, 1, { palette: "red_arrow.pal" }),
      selector_outline: sprite("selector_outline", 8, 8, 8, { palette: "red_arrow.pal" }),
    };
  },

  // Lua: online_ui_extract.lua:63
  manifestRows(rows: unknown): string {
    const body = AssetPack.serialize(rows);
    return body.replace(/^return \{\n/, "").replace(/\n\}\n$/, "");
  },

  // Lua: online_ui_extract.lua:104 (src/mystery_gift_show_card.c:125, :481, src/mystery_gift_menu.c:492)
  giftArt(rom: Rom, write: Write, dir: string): Record<string, unknown> {
    const count: number = Versions.WONDER_STAMP_SHADOW_PAL_COUNT;
    const banks = AssetPack.banks(rom, Versions.WONDER_STAMP_SHADOW_PALS, count);
    const shadow = need(AssetPack.lz(rom, Versions.WONDER_STAMP_SHADOW_GFX), 0x100, "stamp shadow");
    const rows: Record<string, unknown> = {
      stamps: {
        width: 32, height: 16, variants: count, key_prefix: "stamp_shadow_",
        slot_x: [216, 184, 152, 120, 88, 56, 24], slot_y: 144, icon_y: 136,
      },
    };
    for (let i = 0; i <= count - 1; i++) {
      const key = "stamp_shadow_" + i;
      write(dir + "/" + key + ".rgba", AssetPack.frame(shadow, banks[i], 0, 32, 16));
      rows[key] = sprite(key, 32, 16, 1, { palette: "stamp_shadow.pal", bank: i });
    }
    write(dir + "/stamp_shadow.pal", AssetPack.palRgb(banks, 0, count));

    const borderBank = AssetPack.banks(rom, Versions.MYSTERY_GIFT_BORDER_PAL, 1);
    const border = need(AssetPack.lz(rom, Versions.MYSTERY_GIFT_BORDER_GFX), 0x100, "gift textbox border");
    write(dir + "/border_tiles.rgba", AssetPack.strip(border, borderBank[0], 0, 1, 8, 8, 8));
    write(dir + "/border.pal", AssetPack.palRgb(borderBank, 0, 1));
    rows.border_tiles = sprite("border_tiles", 8, 8, 8, { palette: "border.pal" });

    const map: number[] = new Array(32 * 20 * 2).fill(0);
    for (let y = 0; y <= 19; y++) {
      for (let x = 0; x <= 31; x++) {
        let tile: number;
        if (y < 2) tile = 3;
        else if ((y - 2) % 2 !== x % 2) tile = 1;
        else tile = 2;
        const i = (y * 32 + x) * 2;
        map[i] = tile;
        map[i + 1] = 0;
      }
    }
    write(dir + "/menu_bg.rgba", AssetPack.bg(border, borderBank as PalBank[], map, 32, SCREEN_W, SCREEN_H, {}));
    rows.menu_bg = {
      file: "menu_bg.rgba", kind: "bg", width: SCREEN_W, height: SCREEN_H, top_rows: 2, tile: T,
    };
    return rows;
  },

  // Lua: online_ui_extract.lua:151 (src/union_room_player_avatar.c:33-95) -- [male, female]
  avatars(rom: Rom, cache: Cache, root: string): [number[], number[]] {
    const P = AssetPack;
    const ids = P.grid(rom, Versions.UR_OBJ_GFX_IDS, "u8", [2, 10]);
    const male: number[] = [], female: number[] = [];
    for (let i = 1; i <= 8; i++) { male[i - 1] = ids[0][i - 1]; female[i - 1] = ids[1][i - 1]; }
    cache.write(root + "/" + OnlineUiExtract.AVATARS, P.serialize({
      format_version: OnlineUiExtract.FORMAT_VERSION,
      gfx_ids: { male, female },
      leader_coords: P.grid(rom, Versions.UR_PLAYER_COORDS, "s16", [8, 2]),
      group_offsets: P.grid(rom, Versions.UR_GROUP_OFFSETS, "s8", [5, 2]),
      opposite_facing: P.array(rom, Versions.UR_OPPOSITE_FACING, "u8", 5),
      member_facing: P.array(rom, Versions.UR_MEMBER_FACING, "u8", 5),
    }));
    return [male, female];
  },

  // Lua: online_ui_extract.lua:167
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): { root: string } {
    const root = opts.cacheRoot ?? AssetPack.defaultRoot();
    linkArt(rom, cache, root);
    const [male, female] = OnlineUiExtract.avatars(rom, cache, root);
    console.log(format("[online_ui_extract] countdowns, digits, %d avatar gids -> %s", male.length + female.length, root));
    return { root };
  },

  // Lua: online_ui_extract.lua:176
  ready(cache: Cache, cacheRoot?: string): boolean {
    const root = cacheRoot ?? AssetPack.defaultRoot();
    for (const rel of [OnlineUiExtract.LINK_SUB + "/manifest.lua", OnlineUiExtract.AVATARS]) {
      const man = AssetPack.loadManifest(cache, root + "/" + rel);
      if (!man || man.format_version !== OnlineUiExtract.FORMAT_VERSION) return false;
    }
    return AssetPack.sizedFile(cache, root + "/link/countdown_321.rgba", 32 * 192 * 4);
  },
};

export default OnlineUiExtract;
