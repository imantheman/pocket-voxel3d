// Port of gen1recomp src/import/gba/credits_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/credits.c:815, :1101
// LZ77 output and ROM byte runs are 0-based Uint8Arrays here (the Lua's
// 1-based tables); RGBA results are byte strings, as the Lua's.

import { Versions } from "./versions.ts";
import { BgBake, type Bytes, type PalBank } from "./bg_bake.ts";
import { Lz77 } from "./lz77.ts";
import { format, fromBytes, rep, tostring } from "./lua.ts";
import { TextIR } from "../../game/gen3/core/scripting/text_ir.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

const SCREEN_W = 240, SCREEN_H = 160;
// include/overworld.h:38
const SCENE_ROW = 8;

// Lua: credits_extract.lua:44 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: credits_extract.lua:52
function rom_bytes(rom: Rom, off: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = rom.get(off + i);
  return out;
}

// Lua: credits_extract.lua:59
function lz(rom: Rom, off: number): Uint8Array {
  return Lz77.decompress((i: number) => rom.get(i), off)[0];
}

// Lua: credits_extract.lua:65
function s16(v: number): number {
  if (v >= 0x8000) return v - 0x10000;
  return v;
}

// Lua: credits_extract.lua:70
function pointer(rom: Rom, off: number): number {
  const p = rom.ptrOffset(rom.u32(off));
  if (!(p !== undefined && p < rom.size)) throw new Error(format("credits: bad pointer at 0x%X", off));
  return p;
}

// Lua: credits_extract.lua:77 -- src/credits.c:925
function decode_text(rom: Rom, off: number): string {
  let bytes = "";
  for (let i = 0; i <= 1023; i++) {
    const b = rom.get(off + i);
    bytes += String.fromCharCode(b);
    if (b === 0xFF) break;
  }
  const out: string[] = [];
  for (const seg of TextIR.decode(bytes)) {
    if (seg.t === "nl") {
      out.push("\n");
    } else if (seg.t === "ext" && seg.cmd === 0x13) {
      out.push(format("{CLEAR_TO %d}", seg.args![0]));
    } else if (seg.t === "text") {
      out.push(seg.s!);
    } else if (seg.t !== "eos") {
      throw new Error("credits: unexpected text control " + tostring(seg.t) + format(" at 0x%X", off));
    }
  }
  return out.join("");
}

// Lua: credits_extract.lua:99
function quote(s: string): string {
  return format("%q", s).replace(/\\\n/g, "\\n");
}

// Lua: credits_extract.lua:104
function fill(color: number, w: number, h: number): string {
  const [r, g, b] = BgBake.bgr555ToRgb8(color);
  return rep(String.fromCharCode(r, g, b, 255), w * h);
}

// Lua: credits_extract.lua:109 -- top's opaque pixels over base
function over(base: string, top: string): string {
  const n = base.length / 4;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const src = top.charCodeAt(o + 3) > 0 ? top : base;
    for (let k = 0; k < 4; k++) out[o + k] = src.charCodeAt(o + k);
  }
  return fromBytes(out);
}

// Lua: credits_extract.lua:123 -- src/credits.c:1230
function bake_bg4(gfx: Bytes, banks: PalBank[], map: Bytes, mapW?: number): string {
  const top = BgBake.bakeRegionRgba(gfx, banks, map, SCREEN_W, SCREEN_H, { mapW: mapW ?? 32, alpha0: true });
  return over(fill(banks[0]![0]!, SCREEN_W, SCREEN_H), top);
}

// Lua: credits_extract.lua:129
function used_banks(map: Bytes): number {
  let hi = 0;
  for (let i = 0; i < BgBake.byteLen(map); i += 2) {
    const entry = (map[i] ?? 0) + (map[i + 1] ?? 0) * 256;
    hi = Math.max(hi, Math.floor(entry / 4096) % 16);
  }
  return hi + 1;
}

// Lua: credits_extract.lua:138
function closing_screen(rom: Rom, palOff: number, tilesOff: number, mapOff: number): string {
  const gfx = lz(rom, tilesOff);
  const map = lz(rom, mapOff);
  const banks = BgBake.loadPalBanks(rom_bytes(rom, palOff, used_banks(map) * 32));
  return bake_bg4(gfx, banks, map, 32);
}

// Lua: credits_extract.lua:146 -- src/credits.c:1128 -- [rgba, size]
function bake_circle(rom: Rom): [string, number] {
  const C = Versions.CREDITS;
  const tiles = lz(rom, C.circle_tiles);
  const map = lz(rom, C.circle_map);
  const pal = BgBake.loadPalBanks(rom_bytes(rom, C.circle_pal, 32), 1)[0]!;
  const size = 256;
  const tilesPerRow = size / 8;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tile = map[Math.floor(y / 8) * tilesPerRow + Math.floor(x / 8)] ?? 0;
      const v = tiles[tile * 64 + (y % 8) * 8 + (x % 8)] ?? 0;
      if (v !== 0) {
        if (!(v >= 0xF0)) throw new Error(format("credits: circle pixel %d outside BG palette 15", v));
        const [r, g, b] = BgBake.bgr555ToRgb8(pal[v - 0xF0]!);
        const o = (y * size + x) * 4;
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
      }
    }
  }
  return [fromBytes(out), size];
}

// Lua: credits_extract.lua:170
function mon_palette(rom: Rom, species: number): PalBank {
  const tbl = Versions.INTRO.mon_palette_table;
  const pal = lz(rom, pointer(rom, tbl + species * 8));
  return BgBake.loadPalBanks(pal, 1)[0]!;
}

interface WinTemplate { bg: number; left: number; top: number; width: number; height: number; palette: number; baseBlock: number }

// Lua: credits_extract.lua:176 (0-based list: the Lua's tmpl[f + 1] is tmpl[f])
function read_windows(rom: Rom, off: number): WinTemplate[] {
  const out: WinTemplate[] = [];
  for (let i = 0; i <= 3; i++) {
    const b = off + i * 8;
    if (rom.get(b) === 0xFF) break;
    out.push({
      bg: rom.get(b),
      left: rom.get(b + 1),
      top: rom.get(b + 2),
      width: rom.get(b + 3),
      height: rom.get(b + 4),
      palette: rom.get(b + 5),
      baseBlock: rom.u16(b + 6),
    });
  }
  if (out.length !== 3) throw new Error("credits: mon scene window templates");
  return out;
}

// Lua: credits_extract.lua:196 -- src/credits.c:383
function read_script(rom: Rom): { cmd: number; param: number; duration: number }[] {
  const C = Versions.CREDITS;
  const rows: { cmd: number; param: number; duration: number }[] = [];
  for (let i = 0; i <= C.script_max - 1; i++) {
    const b = C.script + i * 4;
    const row = { cmd: rom.get(b), param: rom.get(b + 1), duration: rom.u16(b + 2) };
    rows.push(row);
    if (row.cmd === 5) return rows;
    if (!(row.cmd <= 5)) throw new Error(format("credits: unknown script cmd %d", row.cmd));
  }
  throw new Error("credits: script has no WAITBUTTON");
}

type SceneRow =
  | { op: "loadmap"; mapGroup: number; mapNum: number; x: number; y: number; delay: number }
  | { op: "scroll"; xspeed: number; yspeed: number; length: number };

// Lua: credits_extract.lua:210 -- src/overworld.c:2384
function read_scene(rom: Rom, off: number): SceneRow[] {
  const rows: SceneRow[] = [];
  let i = 0;
  for (;;) {
    const b = off + i * SCENE_ROW;
    const a0 = s16(rom.u16(b)), a2 = s16(rom.u16(b + 2)), a4 = s16(rom.u16(b + 4));
    if (a0 === 0xFD) break;
    if (a0 === 0xFE) {
      const n = off + (i + 1) * SCENE_ROW;
      rows.push({
        op: "loadmap", mapGroup: a2, mapNum: a4,
        x: s16(rom.u16(n)), y: s16(rom.u16(n + 2)), delay: s16(rom.u16(n + 4)),
      });
      i = i + 2;
    } else {
      rows.push({ op: "scroll", xspeed: a0, yspeed: a2, length: a4 });
      i = i + 1;
    }
    if (!(i < 16)) throw new Error("credits: overworld scene has no end");
  }
  return rows;
}

// Lua: credits_extract.lua:233
function write_pack(rom: Rom, game: string): string {
  const C = Versions.CREDITS;
  const L: string[] = [
    "return {",
    format("  format_version = %d,", CreditsExtract.FORMAT_VERSION),
    format("  title = %s,", quote(decode_text(rom, game === "leafgreen" ? C.staff_leafgreen : C.staff_firered))),
    "  script = {",
  ];
  for (const r of read_script(rom)) {
    L.push(format("    { cmd = %d, param = %d, duration = %d },", r.cmd, r.param, r.duration));
  }
  L.push("  },");
  L.push("  texts = {");
  for (let i = 0; i <= C.text_count - 1; i++) {
    const b = C.texts + i * 12;
    L.push(format("    [%d] = { title = %s, names = %s, unused = %s },", i,
      quote(decode_text(rom, pointer(rom, b))), quote(decode_text(rom, pointer(rom, b + 4))),
      tostring(rom.get(b + 8) !== 0)));
  }
  L.push("  },");
  L.push("  scenes = {");
  for (let i = 0; i <= C.scene_count - 1; i++) {
    const parts: string[] = [];
    for (const r of read_scene(rom, pointer(rom, C.scenes + i * 4))) {
      if (r.op === "loadmap") {
        parts.push(format('{ op = "loadmap", mapGroup = %d, mapNum = %d, x = %d, y = %d, delay = %d }',
          r.mapGroup, r.mapNum, r.x, r.y, r.delay));
      } else {
        parts.push(format('{ op = "scroll", xspeed = %d, yspeed = %d, length = %d }', r.xspeed, r.yspeed, r.length));
      }
    }
    L.push(format("    [%d] = { %s },", i, parts.join(", ")));
  }
  L.push("  },");
  L.push("  spriteParams = {");
  for (let i = 0; i <= C.sprite_param_count - 1; i++) {
    const b = C.sprite_params + i * 6;
    L.push(format("    [%d] = { character = %d, ground = %d, motion = %d },", i, rom.u16(b), rom.u16(b + 2), rom.u16(b + 4)));
  }
  L.push("  },");
  L.push("  mons = {");
  CreditsExtract.MONS.forEach((m, i) => {
    const wins: string[] = [];
    for (const w of read_windows(rom, C[m.windows])) {
      wins.push(format("{ left = %d, top = %d, width = %d, height = %d }", w.left, w.top, w.width, w.height));
    }
    L.push(format("    [%d] = { key = %q, species = %d, windows = { %s } },", i, m.key, m.species, wins.join(", ")));
  });
  L.push("  },");
  L.push("}");
  return L.join("\n") + "\n";
}

export const CreditsExtract = {
  CACHE_SUB: "credits",
  FORMAT_VERSION: 1,

  // src/credits.c:1084
  MONS: [
    { key: "charizard", species: 6, frames: ["charizard_1", "charizard_2"], windows: "windows_charizard" },
    { key: "venusaur", species: 3, frames: ["venusaur_1", "venusaur_2"], windows: "windows_venusaur" },
    { key: "blastoise", species: 9, frames: ["blastoise_1", "blastoise_2"], windows: "windows_blastoise" },
    { key: "pikachu", species: 25, frames: ["pikachu_1", "pikachu_2"], windows: "windows_pikachu" },
  ],

  // src/credits.c:466
  SPRITES: [
    { key: "player_male", w: 64, h: 64, frames: 6 },
    { key: "player_female", w: 64, h: 64, frames: 6 },
    { key: "rival", w: 64, h: 64, frames: 6 },
    { key: "ground_grass", w: 64, h: 32, frames: 8 },
    { key: "ground_dirt", w: 64, h: 32, frames: 8 },
    { key: "ground_city", w: 64, h: 32, frames: 8 },
  ],

  FILES: [
    "manifest.lua", "pack.lua", "copyright.rgba", "the_end.rgba", "circle.rgba",
    "pokeball_0.rgba", "pokeball_1.rgba", "pokeball_2.rgba", "pokeball_3.rgba",
    "mon_0_1.rgba", "mon_0_2.rgba", "mon_1_1.rgba", "mon_1_2.rgba",
    "mon_2_1.rgba", "mon_2_2.rgba", "mon_3_1.rgba", "mon_3_2.rgba",
    "player_male.rgba", "player_female.rgba", "rival.rgba",
    "ground_grass.rgba", "ground_dirt.rgba", "ground_city.rgba",
  ],

  // Lua: credits_extract.lua:292
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string; game?: string } = {}): { root: string } {
    const C = Versions.CREDITS;
    const root = (opts.cacheRoot ?? default_cache_root()) + "/" + CreditsExtract.CACHE_SUB;
    let game = opts.game;
    if (!game) {
      const [ver, why] = Versions.lookup(rom.md5);
      game = ver && ver.game;
      if (!game) throw new Error("credits: unknown FRLG edition: " + tostring(why));
    }
    const put = (name: string, body: string): void => {
      if (!cache.write(root + "/" + name, body)) throw new Error("assertion failed!");
    };

    put("pack.lua", write_pack(rom, game!));
    put("copyright.rgba", closing_screen(rom, C.copyright_pal, C.copyright_tiles, C.copyright_map));
    put("the_end.rgba", closing_screen(rom, C.the_end_pal, C.the_end_tiles, C.the_end_map));
    const [circle, circleSize] = bake_circle(rom);
    put("circle.rgba", circle);

    const ballGfx = lz(rom, C.pokeball_tiles);
    const ballMap = lz(rom, C.pokeball_map);
    const wins: WinTemplate[][] = [];
    CreditsExtract.MONS.forEach((m, i) => {
      const banks = BgBake.loadPalBanks(rom_bytes(rom, C.pokeball_pals + i * 32, 32), 1);
      put(format("pokeball_%d.rgba", i), bake_bg4(ballGfx, banks, ballMap, 32));
      const pal = mon_palette(rom, m.species);
      const tmpl = read_windows(rom, C[m.windows]);
      wins[i] = tmpl;
      for (let f = 1; f <= 2; f++) {
        const w = tmpl[f]!.width * 8, h = tmpl[f]!.height * 8;
        const gfx = lz(rom, C[m.frames[f - 1]!]);
        if (BgBake.byteLen(gfx) !== w * h / 2) {
          throw new Error(format("credits: %s is %d bytes, window is %dx%d", m.frames[f - 1], BgBake.byteLen(gfx), w, h));
        }
        put(format("mon_%d_%d.rgba", i, f), BgBake.bakeSpriteRgba(gfx, pal, 0, w, h, false, false));
      }
    });

    const sheets: string[] = [];
    for (const s of CreditsExtract.SPRITES) {
      const gfx = lz(rom, C[s.key + "_tiles"]);
      const tilesPerFrame = (s.w / 8) * (s.h / 8);
      if (!(BgBake.byteLen(gfx) >= tilesPerFrame * 32 * s.frames)) {
        throw new Error(format("credits: %s holds %d bytes", s.key, BgBake.byteLen(gfx)));
      }
      const bank = BgBake.loadPalBanks(rom_bytes(rom, C[s.key + "_pal"], 32), 1)[0];
      const parts: string[] = [];
      for (let f = 0; f < s.frames; f++) {
        parts.push(BgBake.bakeSpriteRgba(gfx, bank, f * tilesPerFrame, s.w, s.h, false, false));
      }
      put(s.key + ".rgba", parts.join(""));
      sheets.push(format("    %s = { w = %d, h = %d, frames = %d },", s.key, s.w, s.h, s.frames));
    }

    const monLines: string[] = [];
    wins.forEach((tmpl, i) => {
      monLines.push(format("    [%d] = { frame1 = { w = %d, h = %d }, frame2 = { w = %d, h = %d } },", i,
        tmpl[1]!.width * 8, tmpl[1]!.height * 8, tmpl[2]!.width * 8, tmpl[2]!.height * 8));
    });
    put("manifest.lua", [
      "return {",
      format("  format_version = %d,", CreditsExtract.FORMAT_VERSION),
      format("  screen = { w = %d, h = %d },", SCREEN_W, SCREEN_H),
      format("  circle = { w = %d, h = %d },", circleSize, circleSize),
      "  sheets = {",
      sheets.join("\n"),
      "  },",
      "  mons = {",
      monLines.join("\n"),
      "  },",
      "}",
      "",
    ].join("\n"));

    console.log(format("[credits_extract] staff roll, closing screens and scene art -> %s", root));
    return { root };
  },

  // Lua: credits_extract.lua:367
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + CreditsExtract.CACHE_SUB;
    if (!(cache && cache.exists)) return false;
    for (const rel of CreditsExtract.FILES) {
      if (!cache.exists(root + "/" + rel)) return false;
    }
    return true;
  },
};

export default CreditsExtract;
