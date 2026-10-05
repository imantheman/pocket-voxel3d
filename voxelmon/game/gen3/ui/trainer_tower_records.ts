// Port of gen1recomp src/ui/game3/trainer_tower_records.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/battle_records.c:83 ShowBattleRecords
//
// Required lazily (pcall(require, "src.ui.game3.trainer_tower_records")), so
// it registers itself in G3Lazy. Brian's pcall(require, ...) of fade,
// dataset and CacheFs always succeed here (all ported).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { format, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { Display } from "../core/display.ts";
import { Stack } from "./stack.ts";
import { Window, type WindowTemplate } from "./window.ts";
import { FrlgFont } from "./frlg_font.ts";
import { Strings } from "../shared/core/Strings.ts";
import { RomText } from "../core/rom_text.ts";
import { Tower } from "../core/trainer_tower.ts";
import { SE } from "../core/se_ids.ts";
import { Fade as FadeM } from "./fade.ts";
import { Audio } from "../core/audio.ts";
import { Dataset } from "../core/dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { G3Lazy } from "../core/lazy_registry.ts";
import { G } from "../platform/graphics.ts";
import { Fs } from "../platform/fs.ts";
import { newImageData, type Image } from "../platform/image.ts";
import { luaLoad } from "../platform/luadata.ts";
import { ipairs, len, seq, type LuaTable } from "../platform/lt.ts";

interface TowerRow { label: string; time: string; frames: number }
interface LinkRow { name: string; wins: string; losses: string; draws: string }

let modeText: Record<number, string | undefined> | undefined;

// Lua: trainer_tower_records.lua:50
function log(key: string, msg: unknown): void {
  if (Records._logged[key]) return;
  Records._logged[key] = true;
  console.log("[game3/tower_records] " + tostring(msg));
}

// Lua: trainer_tower_records.lua:56
function fade(): typeof FadeM | null {
  const F: any = FadeM;
  if (F && F.MODE) return FadeM;
  return null;
}

// Lua: trainer_tower_records.lua:62
function se(id: number | undefined): void {
  try { (Audio as any).playSe(id); } catch { /* pcall */ }
}

// Lua: trainer_tower_records.lua:66
function read_bytes(rel: string): string | null {
  {
    const D: any = Dataset;
    if (D && D.cache) {
      let cache: any;
      try { cache = D.cache(); } catch { cache = undefined; }
      if (cache && cache.read) {
        let d: unknown;
        try { d = cache.read(rel); } catch { d = undefined; }
        if (typeof d === "string" && d.length > 0) return d;
      }
    }
  }
  {
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

// Lua: trainer_tower_records.lua:93
function bg_size(): [number, number] {
  const src = read_bytes(Records.CACHE_MANIFEST);
  if (typeof src !== "string" || src.length === 0) return [Records.BG_W, Records.BG_H];
  const [chunk] = luaLoad(src, "@" + Records.CACHE_MANIFEST);
  let ok = true, pack: any;
  try { pack = chunk!(); } catch { ok = false; }
  const row = ok && pack != null && typeof pack === "object" && (pack.recordsBg || (pack.frames && pack.frames.recordsBg));
  if (row != null && typeof row === "object") {
    return [tonumber(row.width) ?? Records.BG_W, tonumber(row.height) ?? Records.BG_H];
  }
  return [Records.BG_W, Records.BG_H];
}

// Lua: trainer_tower_records.lua:105
function background(): Image | null {
  if (Records._bg != null) return Records._bg || null;
  const rgba = read_bytes(Records.CACHE_BG);
  const [w, h] = bg_size();
  if (typeof rgba === "string" && rgba.length >= w * h * 4) {
    let data;
    try { data = newImageData(w, h, "rgba8", rgba); } catch { data = undefined; }
    if (data) {
      let image: Image | undefined;
      try { image = G.newImage(data); } catch { image = undefined; }
      if (image) {
        if (image.setFilter) image.setFilter("nearest", "nearest");
        Records._bg = image;
        return image;
      }
    }
  }
  log("no-bg", "no " + Records.CACHE_BG + " in cache; plain window chrome");
  Records._bg = false;
  return null;
}

// pokefirered/src/trainer_tower.c:1054 PrintTrainerTowerRecords
// Lua: trainer_tower_records.lua:153
function tower_rows(session: any): (TowerRow | null)[] {
  Tower.validateRecord(session);
  const rows: (TowerRow | null)[] = [null];
  for (let i = 0; i <= Tower.NUM_CHALLENGE_TYPES - 1; i++) {
    const best = Tower.bestTime(session, i);
    rows[i + 1] = {
      label: Records.MODE_TEXT[i + 1]!,
      time: Records.timeText(best),
      frames: best,
    };
  }
  return rows;
}

// pokefirered/src/trainer_tower.c:899 ShowResultsBoard
// Lua: trainer_tower_records.lua:168
function board_rows(session: any): (TowerRow | null)[] {
  Tower.validateRecord(session);
  const best = Tower.bestTime(session);
  const rows: (TowerRow | null)[] = [null];
  for (let i = 0; i <= Tower.NUM_CHALLENGE_TYPES - 1; i++) {
    // pokefirered/src/trainer_tower.c:915 gTrainerTowerChallengeTypeTexts[i - 1]
    const name = Records.MODE_TEXT[i];
    rows[i + 1] = {
      label: name || "",
      time: Records.timeText(best),
      frames: best,
    };
  }
  return rows;
}

// Lua: trainer_tower_records.lua:184
function record_number(valueIn: unknown): number {
  let value = Math.floor(tonumber(valueIn) ?? 0);
  if (value < 0) value = 0;
  // pokefirered/src/battle_records.c:462
  if (value > 9999) value = 9999;
  return value;
}

// pokefirered/src/battle_records.c:541 PrintBattleRecords
// Lua: trainer_tower_records.lua:193
function link_rows(session: any): (LinkRow | null)[] {
  const stored = (session != null && typeof session === "object" && session.linkBattleRecords) || {};
  const rows: (LinkRow | null)[] = [null];
  for (let i = 1; i <= Records.LINK_ROWS; i++) {
    const entry = (stored[i] != null && typeof stored[i] === "object") ? stored[i] : null;
    const wins = record_number(entry && entry.wins);
    const losses = record_number(entry && entry.losses);
    const draws = record_number(entry && entry.draws);
    if (entry && (wins > 0 || losses > 0 || draws > 0)) {
      rows[i] = {
        name: tostring(entry.name ?? ""),
        wins: format("%4d", wins),
        losses: format("%4d", losses),
        draws: format("%4d", draws),
      };
    } else {
      // pokefirered/src/strings.c:599, :600
      const dashes4 = RomText.plain("gString_BattleRecords_4Dashes");
      rows[i] = { name: RomText.plain("gString_BattleRecords_7Dashes"), wins: dashes4, losses: dashes4, draws: dashes4 };
    }
  }
  return rows;
}

// pokefirered/src/battle_records.c:130
// Lua: trainer_tower_records.lua:230
function fade_in(): void {
  const F = fade();
  if (!F) return;
  const covered = (tonumber(F.t) ?? 0) > 0 || (F.isActive && F.isActive());
  if (!covered) return;
  F.begin(F.MODE.FROM_BLACK, 1, () => {});
}

// Lua: trainer_tower_records.lua:269
function finish(): void {
  Records.open = false;
  Records._phase = "idle";
  Stack.pop(Records.ID);
  const cb = Records._onDone;
  Records._onDone = null;
  // pokefirered/src/battle_records.c:189 CB2_ReturnToFieldContinueScriptPlayMapMusic
  const F = fade();
  if (F && (tonumber(F.t) ?? 0) > 0) {
    F.begin(F.MODE.FROM_BLACK, 1, () => {});
  }
  if (cb) cb();
}

// Lua: trainer_tower_records.lua:323
function print_at(text: string, px: number, py: number): void {
  Window.printPx(text, px, py, { colors: FrlgFont.COLOR.NORMAL } as any);
}

export const Records = {
  ID: "trainer_tower_records",

  // pokefirered/src/battle_records.c:41
  WINDOW: { left: 2, top: 1, width: 27, height: 18 },
  // pokefirered/src/trainer_tower.c:312
  BOARD_WINDOW: { left: 3, top: 1, width: 27, height: 18 },
  // pokefirered/src/trainer_tower.c:921
  BOARD_WINDOW_ID: 1,
  // pokefirered/include/global.h:238
  LINK_ROWS: 5,

  CACHE_BG: "data/generated/gba/trainer_tower/records_bg.rgba",
  CACHE_MANIFEST: "data/generated/gba/trainer_tower/manifest.lua",
  // Getters, not values: no top-level reads of imports (the gen3 import cycle).
  get BG_W(): number { return Display.W; },
  get BG_H(): number { return Display.H; },

  // pokefirered/src/battle_message.c:1364
  get MODE_TEXT(): Record<number, string | undefined> {
    return (modeText ??= RomText.lazy(seq(
      "gTrainerTowerChallengeTypeTexts[0]",
      "gTrainerTowerChallengeTypeTexts[1]",
      "gTrainerTowerChallengeTypeTexts[2]",
      "gTrainerTowerChallengeTypeTexts[3]",
    ) as unknown as Record<string, string>) as Record<number, string | undefined>);
  },

  open: false,
  _kind: "tower",
  _phase: "idle",
  _rows: [null] as (TowerRow | LinkRow | null)[],
  _session: null as any,
  _onDone: null as (() => void) | null | undefined,
  _logged: {} as Record<string, boolean>,
  _templates: {} as Record<string, WindowTemplate>,
  _title: null as string | null,
  _titleX: 0,
  _total: null as string | null,
  _bg: null as Image | false | null,

  // Lua: trainer_tower_records.lua:129
  resetArt(): void {
    Records._bg = null;
    Records._logged = {};
    Records._templates = {};
  },

  // Lua: trainer_tower_records.lua:135
  template(): WindowTemplate {
    const kind = Records._kind;
    let cached = Records._templates[kind];
    if (cached) return cached;
    const w = (kind === "board") ? Records.BOARD_WINDOW : Records.WINDOW;
    cached = Window.template(w.left, w.top, w.width, w.height);
    Records._templates[kind] = cached;
    return cached;
  },

  // pokefirered/src/trainer_tower.c:872 PRINT_TOWER_TIME
  // Lua: trainer_tower_records.lua:146
  timeText(frames: unknown): string {
    const [minutes, seconds, centiseconds] = Tower.formatTime(frames);
    // pokefirered/src/battle_message.c:1354 gText_XMinYZSec
    return RomText.plain("gText_XMinYZSec", { stringVars: seq(minutes, seconds, centiseconds) });
  },

  // Lua: trainer_tower_records.lua:217
  rows(): (TowerRow | LinkRow | null)[] {
    return Records._rows;
  },

  // Lua: trainer_tower_records.lua:221
  kind(): string {
    return Records._kind;
  },

  // Lua: trainer_tower_records.lua:225
  isOpen(): boolean {
    return Records.open;
  },

  // Lua: trainer_tower_records.lua:238
  show(opts?: any): LuaTable {
    opts = opts || {};
    Records._session = opts.session || Tower.sessionOf();
    Records._kind = opts.kind || "tower";
    Records._onDone = opts.onDone;
    Records._title = null; Records._total = null;
    if (Records._kind === "link") {
      Records._rows = link_rows(Records._session);
      // pokefirered/src/strings.c:596
      const name = (Records._session != null && typeof Records._session === "object" && Records._session.name) || "";
      Records._title = RomText.plain("gString_BattleRecords_PlayersBattleResults", { playerName: tostring(name) });
      Records._titleX = Math.floor((0xD0 - (FrlgFont.measure(Records._title) || 0)) / 2);
      // pokefirered/src/strings.c:597
      Records._total = Records.totalText(Records._session);
    } else if (Records._kind === "board") {
      Records._rows = board_rows(Records._session);
    } else {
      Records._rows = tower_rows(Records._session);
    }
    Records.open = true;
    if (Records._kind === "board") {
      Records._phase = "wait";
      Stack.push(Records.ID, Records as LuaTable, { hideBelow: false, drawUnder: true });
    } else {
      Records._phase = "in";
      Stack.push(Records.ID, Records as LuaTable, { hideBelow: true, fullscreen: true });
      fade_in();
    }
    return Records;
  },

  // pokefirered/src/battle_records.c:179 Task_FadeOut
  // Lua: trainer_tower_records.lua:284
  close(): boolean {
    if (!Records.open) return false;
    if (Records._kind === "board") {
      finish();
      return true;
    }
    if (Records._phase === "out") return false;
    Records._phase = "out";
    const F = fade();
    if (!F) {
      finish();
      return true;
    }
    F.begin(F.MODE.TO_BLACK, 1, () => {
      if (Records._phase === "out") finish();
    });
    return true;
  },

  // Lua: trainer_tower_records.lua:303
  update(_dt?: number): void {
    if (!Records.open) return;
    if (Records._phase !== "in") return;
    const F = fade();
    if (!F || !(F.isActive && F.isActive())) {
      // pokefirered/src/battle_records.c:162 Task_WaitFadeIn
      Records._phase = "wait";
    }
  },

  // pokefirered/src/battle_records.c:168 Task_WaitButton
  // Lua: trainer_tower_records.lua:314
  handleInput(input: any): void {
    if (!Records.open || !input) return;
    if (Records._phase !== "wait" || Records._kind === "board") return;
    if (input.wasPressed("a") || input.wasPressed("b")) {
      se(SE.SE_SELECT);
      Records.close();
    }
  },

  // Lua: trainer_tower_records.lua:327
  draw(): void {
    if (!Records.open) return;
    const tpl = Records.template();
    const ox = (tpl.left || 0) * Display.TILE;
    const oy = (tpl.top || 0) * Display.TILE;
    if (Records._kind === "board") {
      Window.fixedStdFrame(tpl);
    } else {
      const img = background();
      G.setColor(0, 0, 0, 1);
      G.rectangle("fill", 0, 0, Display.W, Display.H);
      G.setColor(1, 1, 1, 1);
      if (img) {
        // pokefirered/src/battle_records.c:205 ResetGpu
        G.draw(img, 0, 0);
      } else {
        Window.fixedStdFrame(tpl);
      }
    }

    if (Records._kind === "link") {
      // pokefirered/src/strings.c:596
      print_at(Records._title || "", ox + Records._titleX, oy + 4);
      // pokefirered/src/strings.c:597
      print_at(Records._total || "", ox + 12, oy + 24);
      // pokefirered/src/strings.c:598
      const [headers, xs] = Records.columnHeaders();
      for (let i = 1; i <= len(headers); i++) {
        print_at(headers[i]!, ox + 0x54 + xs[i]!, oy + 0x30);
      }
      for (const [i, row] of ipairs<LinkRow>(Records._rows)) {
        const y = oy + 0x3D + 14 * (i - 1);
        print_at(row.name, ox, y);
        print_at(row.wins, ox + 0x54, y);
        print_at(row.losses, ox + 0x84, y);
        print_at(row.draws, ox + 0xB4, y);
      }
      return;
    }

    // pokefirered/src/battle_message.c:1352 gText_TimeBoard
    print_at(RomText.plain("gText_TimeBoard"), ox + 0x4A, oy);
    for (const [i, row] of ipairs<TowerRow>(Records._rows)) {
      if (Records._kind === "board") {
        // pokefirered/src/trainer_tower.c:915
        print_at(row.label, ox + 0x18, oy + 36 + 20 * (i - 1));
        print_at(row.time, ox + 0x60, oy + 46 + 20 * (i - 1));
      } else {
        // pokefirered/src/trainer_tower.c:1068
        const y = oy + 0x24 + 0x14 * (i - 1);
        print_at(row.label, ox + 0x18, y);
        print_at(row.time, ox + 0x60, y);
      }
    }
  },

  // pokefirered/src/strings.c:598 gString_BattleRecords_ColumnHeaders
  // Lua: trainer_tower_records.lua:384
  columnHeaders(): [(string | null)[], (number | null)[]] {
    const out: (string | null)[] = [null];
    const xs: (number | null)[] = seq(0);
    for (const [, segv] of ipairs<any>(RomText.ir("gString_BattleRecords_ColumnHeaders"))) {
      const sg = segv;
      if (sg.t === "text") {
        out[len(out) + 1] = Strings(sg.s);
      } else if (sg.t === "ext" && sg.cmd === 0x13) {
        xs[len(out) + 1] = sg.args[1];
      }
    }
    return [out, xs];
  },

  // pokefirered/src/battle_records.c:452 PrintTotalRecord
  // Lua: trainer_tower_records.lua:397
  totalText(sessionIn?: any): string {
    const session = sessionIn || Records._session;
    // battle_records.c:355, include/constants/game_stat.h:27-29
    const isT = session != null && typeof session === "object";
    const gs = (isT && session.gameStats) || {};
    const wins = record_number(gs[23] || gs.linkBattleWins || (isT && session.linkBattleWins));
    const losses = record_number(gs[24] || gs.linkBattleLosses || (isT && session.linkBattleLosses));
    const draws = record_number(gs[25] || gs.linkBattleDraws || (isT && session.linkBattleDraws));
    // pokefirered/src/battle_records.c:473
    return RomText.plain("gString_BattleRecords_TotalRecord", {
      stringVars: seq(format("%-4d", wins), format("%-4d", losses), format("%-4d", draws)),
    });
  },
};

G3Lazy["src.ui.game3.trainer_tower_records"] = Records;

export default Records;
