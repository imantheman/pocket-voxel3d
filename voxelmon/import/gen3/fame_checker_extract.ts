// Port of gen1recomp src/import/gba/fame_checker_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/fame_checker.c:119, src/graphics.c:1230
// ROM byte runs are 0-based Uint8Arrays here (the Lua's 1-based tables);
// RGBA results are byte strings, as the Lua's.

import { Versions } from "./versions.ts";
import { BgBake } from "./bg_bake.ts";
import { format, fromBytes, tostring } from "./lua.ts";
import { TextIR } from "../../game/gen3/core/scripting/text_ir.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

const PORTRAIT = 64;
const BG_W = 240, BG_H = 160;

// src/fame_checker.c:1342 CreatePersonPicSprite
const OWN_ART = [
  { person: 0, gfx: "FAME_OAK_GFX", pal: "FAME_OAK_PAL" },
  { person: 1, gfx: "FAME_DAISY_GFX", pal: "FAME_DAISY_PAL" },
  { person: 13, gfx: "FAME_BILL_GFX", pal: "FAME_BILL_PAL" },
  { person: 14, gfx: "FAME_FUJI_GFX", pal: "FAME_FUJI_PAL" },
];

// Lua: fame_checker_extract.lua:23 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: fame_checker_extract.lua:31
function rom_bytes(rom: Rom, off: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = rom.get(off + i);
  return out;
}

// Lua: fame_checker_extract.lua:39 -- src/fame_checker.c:209
function decode_text(rom: Rom, off: number): string {
  const bytes: number[] = [];
  for (let i = 0; i <= 1023; i++) {
    const b = rom.get(off + i);
    bytes.push(b);
    if (b === 0xFF) break;
  }
  const out: string[] = [];
  for (const seg of TextIR.decode(bytes)) {
    if (seg.t === "nl") out.push("\n");
    else if (seg.t === "para") out.push("\\p");
    else if (seg.t === "scroll") out.push("\\l");
    else if (seg.t === "player") out.push("{PLAYER}");
    else if (seg.t === "rival") out.push("{RIVAL}");
    else if (seg.t === "strvar") out.push("{STR_VAR_" + tostring(seg.n) + "}");
    else if (seg.t === "text") out.push(seg.s!);
  }
  return out.join("");
}

// Lua: fame_checker_extract.lua:67
function pointer(rom: Rom, off: number): number {
  const p = rom.ptrOffset(rom.u32(off));
  if (p === undefined || p >= rom.size) throw new Error(format("fame_checker: bad pointer at 0x%X", off));
  return p;
}

// Lua: fame_checker_extract.lua:75
function quote(s: string): string {
  return format("%q", s).replace(/\\\n/g, "\\n");
}

// Lua: fame_checker_extract.lua:81 -- src/fame_checker.c:664
function bake_page(rom: Rom): string {
  const gfx = rom_bytes(rom, Versions.FAME_BG_GFX, Versions.FAME_BG3_TILEMAP - Versions.FAME_BG_GFX);
  const banks = BgBake.loadPalBanks(rom_bytes(rom, Versions.FAME_BG_PAL, 64), 2);
  const bg3 = rom_bytes(rom, Versions.FAME_BG3_TILEMAP, 2048);
  const bg2 = rom_bytes(rom, Versions.FAME_BG2_TILEMAP, 2048);
  const base = BgBake.bakeBgRgba(gfx, banks, bg3, BG_W, BG_H);
  const over = BgBake.bakeRegionRgba(gfx, banks, bg2, BG_W, BG_H, { alpha0: true });
  const out = new Uint8Array(BG_W * BG_H * 4);
  for (let i = 0; i < BG_W * BG_H; i++) {
    const o = i * 4;
    const src = over.charCodeAt(o + 3) > 0 ? over : base;
    for (let k = 0; k < 4; k++) out[o + k] = src.charCodeAt(o + k);
  }
  return fromBytes(out);
}

// Lua: fame_checker_extract.lua:102 -- src/fame_checker.c:669
function bake_pick_panel(rom: Rom): string {
  const gfx = rom_bytes(rom, Versions.FAME_BG_GFX, Versions.FAME_BG3_TILEMAP - Versions.FAME_BG_GFX);
  const banks = BgBake.loadPalBanks(rom_bytes(rom, Versions.FAME_BG_PAL, 64), 2);
  const bg1 = rom_bytes(rom, Versions.FAME_BG1_TILEMAP, 2048);
  return BgBake.bakeRegionRgba(gfx, banks, bg1, BG_W, BG_H, { alpha0: true });
}

// Lua: fame_checker_extract.lua:110
function bake_sprite(rom: Rom, gfxOff: number, palOff: number, w: number, h: number): string {
  const tiles = (w / 8) * (h / 8);
  const gfx = rom_bytes(rom, gfxOff, tiles * 32);
  const bank = BgBake.loadPalBanks(rom_bytes(rom, palOff, 32), 1)[0];
  return BgBake.bakeSpriteRgba(gfx, bank, 0, w, h, false, false);
}

// Lua: fame_checker_extract.lua:117
function write_pack(rom: Rom): string {
  const persons: number = Versions.FAME_PERSON_COUNT;
  const slots: number = Versions.FAME_FLAVOR_TEXT_COUNT;
  const lines: string[] = ["return {", "  version = 1,"];

  lines.push("  listNames = {");
  // ipairs over the data table (integer keys 1..n kept as object keys)
  const namePtrs = Versions.FAME_NONTRAINER_NAME_PTRS as Record<number, number>;
  for (let i = 1; namePtrs[i] !== undefined; i++) {
    const person = [0, 1, 13, 14][i - 1];
    lines.push(format("    [%d] = %s,", person, quote(decode_text(rom, namePtrs[i]!))));
  }
  lines.push("  },");

  lines.push("  names = {");
  for (let p = 0; p < persons; p++) {
    const text = decode_text(rom, pointer(rom, Versions.FAME_NAME_QUOTE_PTRS + p * 4));
    lines.push(format("    [%d] = %s,", p, quote(text)));
  }
  lines.push("  },");

  lines.push("  quotes = {");
  for (let p = 0; p < persons; p++) {
    const off = Versions.FAME_NAME_QUOTE_PTRS + (persons + p) * 4;
    lines.push(format("    [%d] = %s,", p, quote(decode_text(rom, pointer(rom, off)))));
  }
  lines.push("  },");

  const tables: [string, number][] = [
    ["flavorText", Versions.FAME_FLAVOR_TEXT_PTRS],
    ["originLocation", Versions.FAME_ORIGIN_LOCATION_PTRS],
    ["originObject", Versions.FAME_ORIGIN_OBJECT_PTRS],
  ];
  for (const row of tables) {
    lines.push("  " + row[0] + " = {");
    for (let p = 0; p < persons; p++) {
      const cells: string[] = [];
      for (let s = 0; s < slots; s++) {
        const off = row[1] + (p * slots + s) * 4;
        cells.push(format("[%d] = %s", s, quote(decode_text(rom, pointer(rom, off)))));
      }
      lines.push(format("    [%d] = { %s },", p, cells.join(", ")));
    }
    lines.push("  },");
  }

  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

export const FameCheckerExtract = {
  CACHE_SUB: "fame_checker",
  MANIFEST_VERSION: 1,

  // Lua: fame_checker_extract.lua:166
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): { root: string; portraits: number } {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + FameCheckerExtract.CACHE_SUB;

    cache.write(root + "/bg.rgba", bake_page(rom));
    cache.write(root + "/pick_panel.rgba", bake_pick_panel(rom));

    for (const row of OWN_ART) {
      const rgba = bake_sprite(rom, Versions[row.gfx], Versions[row.pal], PORTRAIT, PORTRAIT);
      cache.write(format("%s/%d.rgba", root, row.person), rgba);
    }

    // src/fame_checker.c:429
    cache.write(root + "/cursor.rgba", bake_sprite(rom, Versions.FAME_CURSOR_GFX, Versions.FAME_CURSOR_PAL, 32, 32));
    cache.write(root + "/question_mark.rgba", bake_sprite(rom, Versions.FAME_QUESTION_GFX, Versions.FAME_CURSOR_PAL, 16, 32));

    cache.write(root + "/pack.lua", write_pack(rom));

    // src/fame_checker.c:1375 LoadPalette(sSilhouettePalette, OBJ_PLTT_ID(PERSON_PAL_NUM))
    const silhouette = BgBake.loadPalBanks(rom_bytes(rom, Versions.FAME_SILHOUETTE_PAL, 32), 1)[0]!;
    let pal = "";
    for (let i = 0; i <= 15; i++) pal += String.fromCharCode(...BgBake.bgr555ToRgb8(silhouette[i] ?? 0));
    cache.write(root + "/silhouette.pal", pal);

    const picIdxs: string[] = [];
    for (let i = 0; i < Versions.FAME_PERSON_COUNT; i++) picIdxs.push(tostring(rom.get(Versions.FAME_TRAINER_PIC_IDXS + i)));
    cache.write(root + "/manifest.lua", format(`return {
  format_version = %d,
  width = %d,
  height = %d,
  portrait = %d,
  persons = %d,
  flavorTexts = %d,
  trainerPic = { %s },
}
`, FameCheckerExtract.MANIFEST_VERSION, BG_W, BG_H, PORTRAIT,
    Versions.FAME_PERSON_COUNT, Versions.FAME_FLAVOR_TEXT_COUNT, picIdxs.join(", ")));

    console.log(format("[fame_checker_extract] page %dx%d, %d portraits, %d persons -> %s",
      BG_W, BG_H, OWN_ART.length, Versions.FAME_PERSON_COUNT, root));
    return { root, portraits: OWN_ART.length };
  },

  // Lua: fame_checker_extract.lua:218
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + FameCheckerExtract.CACHE_SUB;
    if (!(cache && cache.exists)) return false;
    for (const rel of ["bg.rgba", "pick_panel.rgba", "0.rgba", "1.rgba", "13.rgba", "14.rgba",
      "cursor.rgba", "question_mark.rgba", "silhouette.pal", "pack.lua", "manifest.lua"]) {
      if (!cache.exists(root + "/" + rel)) return false;
    }
    return true;
  },
};

export default FameCheckerExtract;
