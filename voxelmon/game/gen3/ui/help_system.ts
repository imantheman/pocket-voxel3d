// Port of gen1recomp src/ui/game3/help_system.lua (GPLv3 + additional terms; see LICENSE.md).
// FireRed's modal L/R Help. Lives above the normal UI stack so opening Help
// never replaces a menu or advances the field, scripts, battle, or their tasks.
//
// Brian's `package.loaded['src.'..name]` reads (`loaded(name)`) become static
// imports: every module named is part of the port and loaded by Game3, so
// "is it loaded" is always yes.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { HelpExtract } from "../../../import/gen3/help_extract.ts";
import { Options } from "../core/options.ts";
import { Stack } from "./stack.ts";
import { RomText } from "../core/rom_text.ts";
import { Rules } from "../core/help_rules.ts";
import { FrlgFont as Font, type Colors, type FontOpts } from "./frlg_font.ts";
import { Naming } from "./naming.ts";
import { Battle } from "../core/battle.ts";
import { Audio } from "../core/audio.ts";
import { Player } from "../core/player.ts";
import { Fade } from "./fade.ts";
import { BattleTransition } from "../core/battle_transition.ts";
import { Flags } from "../core/scripting/flags.ts";
import { Space } from "../core/scripting/space.ts";
import { PokedexChrome } from "./pokedex_chrome.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image } from "../platform/image.ts";
import { luaLoad } from "../platform/luadata.ts";
import { concat, insert, ipairs, len, unpack, type LuaTable } from "../platform/lt.ts";
import { find, gmatch, gsub } from "../platform/lpattern.ts";

/** The input Help reads: Brian's `input:wasPressed(key)` / `input:isDown(key)`. */
export interface HelpInput { wasPressed(key: string): boolean; isDown?(key: string): boolean }
interface Row { id?: number; label: string }

export interface HelpModule {
  open: boolean;
  seenIntro: boolean;
  pack?: LuaTable;
  _tiles?: Record<number, Image> | null;
  enabled?: boolean;
  contextOverride?: number | null;
  contextBackup?: number | null;
  session?: any;
  contextId?: number;
  _held?: string | null;
  _heldFrames?: number;
  cursor: number;
  scroll: number;
  articleScroll: number;
  maxArticleScroll?: number;
  mainCursor?: number;
  rows: (Row | null)[];
  level?: string;
  topic?: number;
  article?: any;
  installPack(pack: LuaTable): void;
  install(cache: any): boolean;
  reset(): void;
  isOpen(): boolean;
  setContext(id: unknown): boolean;
  context(game: any): number;
  close(): void;
  show(game: any, context?: number): boolean;
  handleInput(input: HelpInput): void;
  update(game: any): boolean;
  draw(): void;
}

const MENU_CONTEXT: Record<string, number> = {
  pokedex: 4, party: 5, bag: 9, berry_pouch: 9, tm_case: 9,
  trainer: 10, save: 12, option: 13, shop: 17, pc_menu: 27, box_storage: 28,
};
const HELD_KEYS = ["up", "down", "left", "right"];
let repeatInput: HelpInput | undefined;
let repeatKey: string | undefined;
let repeatOn = false;
const REPEAT_SHIM: HelpInput = {
  wasPressed(key: string): boolean {
    if (!repeatInput) return false;
    return repeatInput.wasPressed(key) || (repeatOn && key === repeatKey);
  },
};

export const Help: HelpModule = {
  open: false,
  seenIntro: false,
  cursor: 1,
  scroll: 0,
  articleScroll: 0,
  rows: [null],

  // Lua: help_system.lua:18
  installPack(pack: LuaTable): void {
    Help.pack = pack;
    Help._tiles = null;
  },

  // Lua: help_system.lua:22
  install(cache: any): boolean {
    Help.installPack(null);
    const source = cache.read(HelpExtract.PATH);
    if (!truthy(source)) return false;
    // loadstring(source): the pack is a data chunk ("return {...}")
    const [chunk] = luaLoad(source, "=help/pack.lua");
    if (!chunk) return false;
    let ok = true;
    let pack: any;
    try { pack = chunk(); } catch { ok = false; }
    if (!ok || pack == null || typeof pack !== "object" || pack.version !== 1) return false;
    Help.installPack(pack);
    return true;
  },

  // Lua: help_system.lua:33
  reset(): void {
    Help.close();
    Help.seenIntro = false;
    Help.enabled = true;
    Help.contextOverride = null;
    Help.contextBackup = null;
  },

  // Lua: help_system.lua:40
  isOpen(): boolean { return Help.open; },

  // Lua: help_system.lua:41
  setContext(idIn: unknown): boolean {
    const id = tonumber(idIn);
    if (id != null && (id < 0 || id > 35 || id !== Math.floor(id))) return false;
    Help.contextOverride = id ?? null;
    return true;
  },

  // Lua: help_system.lua:47
  context(game: any): number {
    if (Help.contextOverride != null) return Help.contextOverride;
    const naming: any = Naming;
    if (naming && naming.isOpen()) return 3;
    if (game.phase === "boot") {
      const phase = game.boot && game.boot.phase;
      if (phase === "title" || phase === "menu") return 1;
      if (phase === "oak" || phase === "controls" || phase === "pikachu") return 2;
      return 0;
    }
    // Retail deliberately retains battle help in party, bag and summary menus.
    const battle: any = Battle;
    if (battle && battle.isActive()) {
      const state = battle.getState() ?? {};
      if (truthy(state.safari)) return 26;
      if (state.wild === false) return truthy(state.double) ? 25 : 24;
      return 23;
    }
    const top = Stack.top();
    if (top) {
      if (top.id === "summary") return 6 + Math.min(2, top.mod._page ?? 0);
      if (top.id === "trainer") return top.mod.side === "back" ? 11 : 10;
      if (top.id === "pc_menu") {
        const mode = top.mod.mode;
        const bedroom = find((game.session && game.session.map) || "", "PLAYERS_HOUSE");
        if (mode === "storage_menu") return 28;
        if (mode === "oak_pc") return 31;
        if (mode === "item_storage" || find(mode || "", "withdraw") || find(mode || "", "deposit")) {
          return bedroom ? 33 : 29;
        }
        return bedroom ? 32 : 27;
      }
      if (MENU_CONTEXT[top.id] != null) return MENU_CONTEXT[top.id]!;
    }
    const session = game.session || {};
    const map: string = session.map || "";
    const player: any = Player;
    if ((player && truthy(player.surfing)) || truthy(session.surfing)) return 22;
    if (find(map, "PLAYERS_HOUSE")) return 14;
    if (find(map, "OAKS_LAB")) return 15;
    if (find(map, "POKECENTER") || find(map, "POKEMON_CENTER")) return 16;
    if (find(map, "MART") || find(map, "DEPARTMENT_STORE")) return 17;
    if (find(map, "GYM")) return 18;
    const def = game.data && game.data.maps && game.data.maps[map];
    if (def && def.mapType === 4) return 21;
    if (find(map, "VIRIDIAN_FOREST") || find(map, "BERRY_FOREST") || find(map, "PATTERN_BUSH")) return 21;
    if (def && (def.mapType === 8 || def.mapType === 9)) return 19;
    return 20;
  },

  // Lua: help_system.lua:100
  close(): void {
    if (Help.open) audio(251);
    const a: any = Audio;
    if (a && a.setHelpActive) a.setHelpActive(false); // SE_HELP_CLOSE
    Help.open = false;
  },

  // Lua: help_system.lua:132
  show(game: any, context?: number): boolean {
    if (!truthy(Help.pack)) return false;
    Help.session = game.session || {};
    Help.contextId = context ?? Help.context(game);
    if (Help.contextId === 0 || Help.contextId === 35) return false;
    Help._held = null; Help._heldFrames = 0;
    Help.open = true; Help.cursor = 1; Help.scroll = 0; Help.articleScroll = 0;
    Help.rows = mainItems();
    Help.level = (Help.seenIntro || truthy(Rules.flag(Help.session, "SYS_SAW_HELP_SYSTEM_INTRO"))) ? "main" : "welcome";
    if (game.session) {
      const SpaceM: any = Space;
      Flags.setFlag((SpaceM && truthy(SpaceM.store)) ? SpaceM.store : game.session, null, Flags.IDS.SYS_SAW_HELP_SYSTEM_INTRO, true);
      game.session.flags = game.session.flags || {};
      Flags.setFlag(game.session, null, Flags.IDS.SYS_SAW_HELP_SYSTEM_INTRO, true);
    }
    const a: any = Audio;
    if (a && a.setHelpActive) a.setHelpActive(true);
    Help.seenIntro = true;
    audio(250); // SE_HELP_OPEN
    return true;
  },

  // Lua: help_system.lua:154
  handleInput(input: HelpInput): void {
    if (input.wasPressed("l") || input.wasPressed("r")) { Help.close(); return; }
    const back = input.wasPressed("b");
    const accept = input.wasPressed("a");
    if (Help.level === "welcome") {
      if (accept) { Help.level = "main"; audio(5); }
    } else if (Help.level === "article") {
      if (back || accept) {
        Help.level = "submenu"; audio(5);
      } else if (input.wasPressed("down")) {
        Help.articleScroll = Math.min(Help.maxArticleScroll || 0, Help.articleScroll + 1);
      } else if (input.wasPressed("up")) Help.articleScroll = Math.max(0, Help.articleScroll - 1);
    } else if (back) {
      if (Help.level === "main") Help.close();
      else { Help.level = "main"; Help.rows = mainItems(); Help.cursor = Help.mainCursor!; Help.scroll = 0; audio(5); }
    } else if (accept) {
      const row = Help.rows[Help.cursor]!;
      if (row.id == null) {
        if (Help.level === "main") Help.close();
        else { Help.level = "main"; Help.rows = mainItems(); Help.cursor = Help.mainCursor!; Help.scroll = 0; }
      } else if (Help.level === "main") {
        Help.mainCursor = Help.cursor; Help.topic = row.id;
        Help.rows = submenuItems(); Help.cursor = 1; Help.scroll = 0; Help.level = "submenu"; audio(5);
      } else {
        Help.article = Help.pack.entries[Help.topic!][row.id];
        Help.articleScroll = 0; Help.level = "article"; audio(5);
      }
    } else {
      const delta = input.wasPressed("up") ? -1 : input.wasPressed("down") ? 1
        : input.wasPressed("left") ? -7 : input.wasPressed("right") ? 7 : 0;
      if (delta !== 0) {
        Help.cursor = Math.max(1, Math.min(len(Help.rows), Help.cursor + delta));
        Help.scroll = Math.max(0, Math.min(Help.scroll, Help.cursor - 1));
        if (Help.cursor > Help.scroll + 7) Help.scroll = Help.cursor - 7;
        audio(5);
      }
    }
  },

  // Lua: help_system.lua:192
  update(game: any): boolean {
    const input: HelpInput | undefined = game.input;
    if (!input) return false;
    if (Help.open) {
      // GBA joypad repeat: delay before held directions repeat every five frames.
      let heldKey: string | undefined;
      for (const key of HELD_KEYS) {
        if (input.isDown && input.isDown(key)) { heldKey = key; break; }
      }
      if ((heldKey ?? null) !== (Help._held ?? null)) { Help._held = heldKey ?? null; Help._heldFrames = 0; }
      Help._heldFrames = (Help._heldFrames || 0) + 1;
      repeatInput = input; repeatKey = heldKey;
      repeatOn = heldKey != null && Help._heldFrames >= 20 && (Help._heldFrames - 20) % 5 === 0;
      Help.handleInput(REPEAT_SHIM);
      return true;
    }
    if (!truthy(Help.pack) || Help.enabled === false) return false;
    if (tonumber(Options.ensure(game.session || {}).buttonMode) !== 0) return false;
    if (!input.wasPressed("l") && !input.wasPressed("r")) return false;
    const fade: any = Fade;
    const transition: any = BattleTransition;
    if ((fade && fade.isActive()) || (transition && transition.isActive())) return false;
    return Help.show(game);
  },

  // Lua: help_system.lua:274
  draw(): void {
    if (!Help.open) return;
    const g = G;
    g.push("all"); g.origin(); g.setScissor();
    tile(8, 0, 0, 240, 160);
    tile(2, 0, 0, 8, 160); tile(2, 232, 0, 8, 160);
    const article = Help.level === "article";
    if (article) tile(3, 8, 24, 224, 136);
    tile(article ? 4 : 0, 8, 16, 224, 8);
    tile(article ? 5 : 1, 8, 152, 224, 8);
    // src/help_system_util.c:87
    text(RomText.plain("gString_Help"), 14, 2, true);
    const controls = RomText.plain(Help.level === "welcome" ? "gText_HelpSystemControls_A_Next" // src/help_system.c:2291
      : article ? "gText_HelpSystemControls_AorBtoCancel" // src/help_system.c:2396
        : Help.level === "main" ? "gText_HelpSystemControls_PickOkEnd" // src/help_system.c:1942
          : "gText_HelpSystemControls_PickOkCancel"); // src/help_system.c:1975
    const Chrome: any = PokedexChrome;
    Chrome.drawControlInfoLeft(controls, Math.max(75, 232 - Chrome.measureControlInfo(controls)), 2);
    g.setScissor(16, 24, 208, 128);
    if (Help.level === "welcome") {
      text(Help.pack.greetings, 16, 24);
    } else if (article) {
      text(Help.article.question, 16, 24);
      g.setScissor(8, 24, 224, 128);
      tile(5, 8, 40, 224, 8);
      g.setScissor(16, 48, 208, 104);
      const lines = help_lines(Help.article.answer);
      Help.maxArticleScroll = Math.max(0, len(lines) - 7);
      for (let i = 1; i <= 7; i++) text(lines[i + Help.articleScroll], 16, 48 + (i - 1) * 15);
    } else {
      const sub = Help.level === "submenu";
      if (sub) text(Help.pack.topics[Help.topic!], 16, 24);
      const n = sub ? 7 : len(Help.rows);
      for (let i = 1; i <= n; i++) {
        const row = Help.rows[i + Help.scroll];
        if (row) {
          const y = (sub ? 45 : 28) + (i - 1) * 15;
          if (Help.cursor === i + Help.scroll) {
            Font.drawGlyph(0xEF, 16, y, { colors: { fg: [1, 1, 1, 1], shadow: [98 / 255, 98 / 255, 98 / 255, 1] } as Colors });
          }
          text(row.label, 24, y);
        }
      }
      if (sub) {
        g.setScissor(8, 24, 224, 128);
        if (Help.scroll > 0) tile(7, 224, 24, 8, 8);
        if (Help.scroll + 7 < len(Help.rows)) tile(6, 224, 144, 8, 8);
      } else {
        const row = Help.rows[Help.cursor]!;
        g.setColor(1, 1, 1, 1); g.rectangle("fill", 16, 112, 208, 40);
        const dopts: FontOpts = { colors: { fg: [98 / 255, 98 / 255, 98 / 255, 1], shadow: [213 / 255, 213 / 255, 205 / 255, 1] } as Colors };
        for (const [i, line] of ipairs<string>(help_lines(Help.pack.descriptions[row.id ?? 6] || ""))) {
          text_line(line, 18, 118 + (i - 1) * 15, false, dopts);
        }
      }
    }
    g.pop();
  },
};

// Lua: help_system.lua:96
function audio(id: number): void {
  const a: any = Audio;
  if (a && a.playSe) a.playSe(id);
}

// Lua: help_system.lua:106
function mainItems(): (Row | null)[] {
  const rows: (Row | null)[] = [null];
  for (const topic of [4, 1, 2, 3, 5]) {
    if (Help.pack.contexts[Help.contextId!] && Help.pack.contexts[Help.contextId!][topic]) {
      rows[len(rows) + 1] = { id: topic, label: Help.pack.topics[topic] };
    }
  }
  rows[len(rows) + 1] = { label: Help.pack.topics[6] };
  return rows;
}

// Lua: help_system.lua:116
function submenuItems(): (Row | null)[] {
  const rows: (Row | null)[] = [null];
  const used: Record<number, boolean> = {};
  const basics = Help.topic === 3 && truthy(Rules.flag(Help.session, "DEFEATED_BROCK"));
  const basicIds: Record<number, boolean> = {};
  if (basics) for (const [, id] of ipairs<number>(Help.pack.basic)) basicIds[id] = true;
  const add = (id: number): void => {
    const entry = Help.pack.entries[Help.topic!][id];
    if (entry && !used[id]) { rows[len(rows) + 1] = { id, label: entry.question }; used[id] = true; }
  };
  for (const [, id] of ipairs<number>(Help.pack.contexts[Help.contextId!][Help.topic!] || [null])) {
    if (!basicIds[id] && truthy(Rules.enabled(Help.topic!, id, Help.session))) add(id);
  }
  if (basics) for (const [, id] of ipairs<number>(Help.pack.basic)) add(id);
  rows[len(rows) + 1] = { label: Help.pack.cancel };
  return rows;
}

// Lua: help_system.lua:216
function expand(s: unknown): string {
  let out = gsub(tostring(truthy(s) ? s : ""), "{PLAYER}", () => Help.session.name || Help.session.playerName || "PLAYER")[0];
  out = gsub(out, "{RIVAL}", () => Help.session.rivalName || "RIVAL")[0];
  // src/help_system_util.c:429
  out = gsub(out, "{PC_OWNER}", () => RomText.plain(truthy(Rules.flag(Help.session, "SYS_NOT_SOMEONES_PC")) ? "gString_Bill" : "gString_Someone"))[0];
  return out;
}

// Lua: help_system.lua:222
function help_lines(s: unknown): (string | null)[] {
  let clean = gsub(expand(s), "\\n", "\n")[0];
  clean = gsub(clean, "\\l", "\n")[0];
  clean = gsub(clean, "\\p", "\n")[0];
  const lines: (string | null)[] = [null];
  for (const [line] of gmatch(clean + "\n", "(.-)\n")) lines[len(lines) + 1] = line as string;
  return lines;
}

// src/help_system_util.c:373
// Lua: help_system.lua:229
function text_line(line: string, x: number, y: number, small: boolean, opts: FontOpts): void {
  const space = small ? 5 : 4;
  let px = x, depth = 0;
  let word: (string | null)[] = [null];
  const flush = (): void => {
    if (len(word) > 0) {
      const w = concat(word);
      const room = x + 208 - px;
      if (room > 0) { opts.maxWidth = room; Font.draw(w, px, y, opts); }
      px = px + Font.measure(w, { small });
      word = [null];
    }
  };
  for (const [ch] of gmatch(line, "[%z\x01-\x7F\xC2-\xF4][\x80-\xBF]*")) {
    if (ch === "{") depth = depth + 1; else if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === " " && depth === 0) { flush(); px = px + space; } else insert(word, ch);
  }
  flush();
}

// Lua: help_system.lua:247
function text(s: unknown, x: number, y: number, small = false, color?: number[]): void {
  const opts: FontOpts = { small, color: color || [1, 1, 1, 1], shadow: [98 / 255, 98 / 255, 98 / 255, 1] };
  for (const [i, line] of ipairs<string>(help_lines(s))) text_line(line, x, y + (i - 1) * 15, small, opts);
}

// Lua: help_system.lua:251
function tile(index: number, x: number, y: number, w: number, h: number): void {
  const g = G;
  const pack = Help.pack;
  // Nine original 4bpp tiles occupy 0x1F7..0x1FF in the Help VRAM bank.
  if (!Help._tiles && pack.tiles && len(pack.tiles) === 288) {
    Help._tiles = {};
    for (let t = 0; t <= 8; t++) {
      const data = newImageData(8, 8);
      for (let py = 0; py <= 7; py++) {
        for (let px = 0; px <= 7; px++) {
          const b: number = pack.tiles[t * 32 + py * 4 + Math.floor(px / 2) + 1];
          const n = px % 2 === 0 ? b % 16 : Math.floor(b / 16);
          const [r, gg, bb, a] = unpack<number>(pack.palette[n + 1]);
          data.setPixel(px, py, r!, gg!, bb!, a);
        }
      }
      const image = g.newImage(data); image.setFilter("nearest", "nearest"); Help._tiles[t] = image;
    }
  }
  g.setColor(1, 1, 1, 1);
  if (Help._tiles) {
    for (let yy = y; yy <= y + h - 1; yy += 8) for (let xx = x; xx <= x + w - 1; xx += 8) g.draw(Help._tiles[index]!, xx, yy);
  } else {
    g.setColor(0, 0.48, 0.77, 1); g.rectangle("fill", x, y, w, h);
  }
}

export default Help;
