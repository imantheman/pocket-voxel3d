// Port of gen1recomp src/ui/game3/summary_menu.lua (GPLv3 + additional terms; see LICENSE.md).
// Pokémon Summary Screen Menu for Game3.
// 1:1 replication of Pokémon FireRed summary screen:
// Pages: INFO (0), SKILLS (1), MOVES (2), MOVES_INFO (3), EGG (4).
// Features: Animated page slide (with anchored foreground), full move swapping (anti-PP swap trap),
// dynamic trainer memo diffing, and ROM-baked chrome graphics.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { format, mod, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import type { Image, Quad } from "../platform/image.ts";
import { ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { match } from "../platform/lpattern.ts";
import { Stack } from "./stack.ts";
import { FrlgFont, type Colors } from "./frlg_font.ts";
import { Pokemon } from "../core/pokemon.ts";
import { Dex } from "../core/dex.ts";
import { PokedexData } from "../core/pokedex_data.ts";
import { PokedexChrome } from "./pokedex_chrome.ts";
import { SummaryChrome } from "./summary_chrome.ts";
import { SummaryData } from "../core/summary_data.ts";
import { Strings } from "../shared/core/Strings.ts";
import { RomText } from "../core/rom_text.ts";
import { ItemsData } from "../core/items_data.ts";
import { Audio } from "../core/audio.ts";
import { Constants } from "../core/constants.ts";
import { Options } from "../core/options.ts";
import { Runtime } from "../core/runtime.ts";
import { Battle } from "../core/battle.ts";
import { BallOpen } from "../core/battle/ball_open.ts";
import { Ui } from "../core/battle/ui.ts";

type Move = { id: any; name: string; pp: any; maxPp: any; type: any; power: string; accuracy: string };
type SlideKind = "page" | "detail" | "back";

const PAGE_INFO = 0;
const PAGE_SKILLS = 1;
const PAGE_MOVES = 2;
const PAGE_MOVES_INFO = 3;
const PAGE_EGG = 4;

// pokefirered/src/pokemon_summary_screen.c:3058
const SLIDE_STEP = 60;
const SLIDE_FRAMES = 240 / SLIDE_STEP;

// pokefirered/src/pokemon_summary_screen.c:1233
const FLIP_TIMING: Record<SlideKind, Record<string, number>> = {
  page: { delay: 6, header: 6, text: 14, done: 15 },
  // pokefirered/src/pokemon_summary_screen.c:1332
  detail: { delay: 8, hide: 4, bg: 7, header: 7, list5: 9, bottom: 13, show: 15, name: 16, done: 17 },
  // pokefirered/src/pokemon_summary_screen.c:1443
  back: { delay: 7, list5: 5, bottom: 5, header: 7, hide: 8, name: 13, bg: 14, show: 14, done: 15 },
};

// pokefirered/src/pokemon_summary_screen.c:3956
const EGG_SHAKE_DELAY: Record<number, number> = { 0: 120, 1: 90, 2: 60 };

// Lua: summary_menu.lua:79. Filled on first use: inside the ES import cycle
// FrlgFont may not be initialised yet when this module loads.
let STAT_COLORS_T: Record<string, Colors> | undefined;
function STAT_COLORS(): Record<string, Colors> {
  if (!STAT_COLORS_T) STAT_COLORS_T = { NORMAL: FrlgFont.COLOR.NORMAL };
  return STAT_COLORS_T;
}

// UTF-8 bytes of the Lua source's literals
const MALE_SIGN = "\xE2\x99\x82"; // ♂
const FEMALE_SIGN = "\xE2\x99\x80"; // ♀
const EM_DASH = "\xE2\x80\x94"; // —

export const SummaryMenu = {
  isMenu: true,

  // pokefirered/src/pokemon_summary_screen.c:2139
  // Lua: summary_menu.lua:23
  heldItemText(mon: any): string {
    const raw = mon && (mon.item ?? mon.heldItem);
    const held = ItemsData.toNumericId(raw) ?? tonumber(raw) ?? 0;
    if (held === 0) return RomText.plain("gText_PokeSum_Item_None");
    return ItemsData.displayName(held);
  },

  open: false,
  _party: null as LuaTable,
  _cursor: 1,
  _page: 0,
  _moveCursor: 1,
  _swapSlot: null as number | null,
  _onClose: null as (() => void) | null,
  _playerState: null as any,
  _session: null as any,
  _context: "party" as any,
  _mode: null as any,
  _enemyParty: false,
  _owner: null as any,
  _moveToLearn: null as any,
  _forgetMove: false,
  _onSelectMove: null as ((slot: number | null) => void) | null,
  _hmNotice: false,
  _slide: {
    active: false,
    kind: "page" as SlideKind,
    direction: 0,
    frame: 0,
    prevPage: 0,
    queued: null as number | null,
  },
  _tick: 0,
  _bounce: { dy: 0, dx: 0, delay: 0, anim: 0, count: 2, vigor: 0, egg: false },
  _blink: { frame: 0, hidden: false },

  PAGE_INFO,
  PAGE_SKILLS,
  PAGE_MOVES,
  PAGE_MOVES_INFO,
  PAGE_EGG,

  FLIP_TIMING,

  // Lua: summary_menu.lua:183
  isOpen(): boolean {
    return SummaryMenu.open;
  },

  // Lua: summary_menu.lua:187
  openMenu(party: LuaTable, startIndex?: number, opts?: any): void {
    opts = opts ?? {};
    SummaryMenu.open = true;
    SummaryMenu._party = party ?? seq();
    SummaryMenu._cursor = startIndex ?? 1;
    // package.loaded["src.core.game3.runtime"]: always loaded here.
    const session = opts.playerState ?? opts.session
      ?? (Runtime && Runtime.getSession ? Runtime.getSession() : undefined);
    SummaryMenu._playerState = session;
    SummaryMenu._context = opts.context ?? "party";
    SummaryMenu._onClose = opts.onClose;
    SummaryMenu._mode = opts.mode; // "select_move" | "party" | nil
    SummaryMenu._enemyParty = opts.enemyParty ? true : false;
    SummaryMenu._owner = opts.owner;
    SummaryMenu._moveToLearn = opts.moveToLearn ?? opts.moveId;
    SummaryMenu._forgetMove = opts.forgetMove === true;
    SummaryMenu._onSelectMove = opts.onSelectMove;
    SummaryMenu._hmNotice = false;
    SummaryMenu._moveCursor = 1;
    SummaryMenu._swapSlot = null;
    SummaryMenu._slide.active = false;
    // pokefirered/src/pokemon_summary_screen.c:1046
    SummaryMenu._slide.queued = null;
    SummaryMenu._tick = 0;

    const mon = current_mon();
    if (mon && Pokemon.isEgg(mon)) {
      SummaryMenu._page = PAGE_EGG;
    } else if (SummaryMenu._mode === "select_move") {
      SummaryMenu._page = PAGE_MOVES_INFO;
    } else {
      SummaryMenu._page = tonumber(opts.page) ?? PAGE_INFO;
    }

    SummaryChrome.install(opts.cache);
    SummaryMenu.resetPicBounce();
    Stack.push("summary", SummaryMenu, { hideBelow: true, fullscreen: true });
    // pokefirered/src/pokemon_summary_screen.c:1111
    play_mon_cry();
  },

  // Lua: summary_menu.lua:227
  close(): void {
    SummaryMenu.open = false;
    SummaryMenu._slide.active = false;
    SummaryMenu._swapSlot = null;
    SummaryMenu._mode = null;
    SummaryMenu._moveToLearn = null;
    SummaryMenu._forgetMove = false;
    const selectCb = SummaryMenu._onSelectMove;
    SummaryMenu._onSelectMove = null;
    Stack.pop("summary");
    if (SummaryMenu._onClose) {
      const cb = SummaryMenu._onClose;
      SummaryMenu._onClose = null;
      cb();
    }
    if (selectCb) {
      selectCb(null);
    }
  },

  // pokefirered/src/pokemon_summary_screen.c:4048
  // Lua: summary_menu.lua:281
  resetPicBounce(): void {
    const b = SummaryMenu._bounce;
    b.dy = 0; b.dx = 0; b.delay = 0; b.anim = 0; b.count = 2; b.vigor = 0; b.egg = false;
    const mon = current_mon();
    if (!mon) return;
    if (Pokemon.isEgg(mon)) {
      const cycles = SummaryData.eggCycles(mon);
      b.egg = true;
      // pokefirered/src/pokemon_summary_screen.c:4054
      if (cycles <= 5) b.vigor = 2;
      else if (cycles <= 10) b.vigor = 1;
      b.count = 0;
      return;
    }
    if (ailment_blocks_bounce(SummaryData.statusAilment(mon))) return;
    const curHp = tonumber(mon.hp ?? mon.currentHp) ?? 0;
    const maxHp = tonumber(mon.maxHp ?? mon.maxhp) ?? 0;
    if (curHp === maxHp) b.vigor = 4;
    else if (maxHp * 0.8 <= curHp) b.vigor = 3;
    else if (maxHp * 0.6 <= curHp) b.vigor = 2;
    else b.vigor = 1;
    b.count = 0;
  },

  // Lua: summary_menu.lua:368
  update(dtIn?: unknown): void {
    const dt = tonumber(dtIn) ?? (1 / 60);
    SummaryMenu._tick = (SummaryMenu._tick || 0) + dt * 60;
    while (SummaryMenu._tick >= 0.999) {
      SummaryMenu._tick = SummaryMenu._tick - 1;
      step_frame();
    }
  },

  // pokefirered/src/pokemon_summary_screen.c:3506
  // Lua: summary_menu.lua:394
  detailCursorStep(moves: LuaTable, pos: number, dir: number, swapping: boolean): number {
    const has = (i: number): boolean => i <= 3 && moves[i + 1] != null;
    if (dir < 0) {
      if (pos > 0) {
        for (let i = pos; i >= 1; i--) {
          if (has(i - 1)) return i - 1;
        }
        return pos;
      }
      if (swapping) {
        for (let i = 4; i >= 1; i--) {
          if (has(i - 1)) return i - 1;
        }
      }
      return 4;
    }
    if (pos < 4) {
      let last = 4;
      if (swapping) {
        if (pos === 3) return 0;
        last = 3;
      }
      let i = pos;
      while (i < last) {
        if (has(i + 1)) return i + 1;
        i = i + 1;
      }
      return swapping ? 0 : i;
    }
    return 0;
  },

  // Lua: summary_menu.lua:448
  handleInput(input: any): void {
    if (!input) return;
    const slide = SummaryMenu._slide;
    if (slide.active) {
      // pokefirered/src/pokemon_summary_screen.c:1132
      if (slide.kind === "page") {
        if (page_flip_input(input, 1)) {
          slide.queued = 1;
        } else if (page_flip_input(input, -1)) {
          slide.queued = -1;
        }
      }
      return;
    }

    const mon = current_mon();
    if (!mon) {
      if (input.wasPressed("b") || input.wasPressed("a") || input.wasPressed("start")) {
        SummaryMenu.close();
      }
      return;
    }

    // Select move mode for move replacement (1:1 pret ShowSelectMovePokemonSummaryScreen)
    if (SummaryMenu._mode === "select_move") {
      const moves = moves_for_mon(mon);

      if (input.wasPressed("up")) {
        SummaryMenu._moveCursor = select_move_step(moves, SummaryMenu._moveCursor, -1);
        SummaryMenu._hmNotice = false;
        se(5);
      } else if (input.wasPressed("down")) {
        SummaryMenu._moveCursor = select_move_step(moves, SummaryMenu._moveCursor, 1);
        SummaryMenu._hmNotice = false;
        se(5);
      } else if (input.wasPressed("a")) {
        if (SummaryMenu._moveCursor <= 4) {
          const chosenMove = moves[SummaryMenu._moveCursor] as Move | null;
          const moveId = chosenMove && chosenMove.id;
          // pokefirered/src/pokemon_summary_screen.c:3772
          if (moveId && Pokemon.isHmMove(moveId) && !SummaryMenu._forgetMove) {
            se("SE_FAILURE");
            // pokefirered/src/pokemon_summary_screen.c:3864
            SummaryMenu._hmNotice = true;
          } else {
            se(5);
            const slotIdx = SummaryMenu._moveCursor - 1; // 0-indexed (0..3)
            const cb = SummaryMenu._onSelectMove;
            SummaryMenu._onSelectMove = null;
            SummaryMenu.close();
            if (cb) cb(slotIdx);
          }
        } else {
          // Selected 5th slot (the move to learn / cancel)
          se(5);
          const cb = SummaryMenu._onSelectMove;
          SummaryMenu._onSelectMove = null;
          SummaryMenu.close();
          if (cb) cb(null);
        }
      } else if (input.wasPressed("b")) {
        // pokefirered/src/pokemon_summary_screen.c:3868
        const cb = SummaryMenu._onSelectMove;
        SummaryMenu._onSelectMove = null;
        SummaryMenu.close();
        if (cb) cb(null);
      }
      return;
    }

    // Egg page navigation
    if (SummaryMenu._page === PAGE_EGG) {
      if (input.wasPressed("up")) {
        change_mon(-1);
      } else if (input.wasPressed("down")) {
        change_mon(1);
      } else if (input.wasPressed("b") || input.wasPressed("a") || input.wasPressed("start")) {
        SummaryMenu.close();
      }
      return;
    }

    // Move detail & swap mode
    if (SummaryMenu._page === PAGE_MOVES_INFO) {
      const moves = moves_for_mon(mon);
      const swapping = SummaryMenu._swapSlot != null;
      const pos = SummaryMenu._moveCursor - 1;

      if (input.wasPressed("up")) {
        SummaryMenu._moveCursor = SummaryMenu.detailCursorStep(moves, pos, -1, swapping) + 1;
        se(5);
      } else if (input.wasPressed("down")) {
        SummaryMenu._moveCursor = SummaryMenu.detailCursorStep(moves, pos, 1, swapping) + 1;
        se(5);
      } else if (input.wasPressed("a")) {
        se(5);
        if (pos === 4) {
          // pokefirered/src/pokemon_summary_screen.c:3589
          SummaryMenu._moveCursor = 1;
          start_slide("back", PAGE_MOVES, -1);
        } else if (!swapping) {
          // pokefirered/src/pokemon_summary_screen.c:3604
          // package.loaded["src.core.game3.battle"]: always loaded here.
          const inBattle = Battle && Battle.isActive && Battle.isActive();
          // pokeemerald/src/pokemon_summary_screen.c:1929
          if (!(SummaryMenu._enemyParty || inBattle || SummaryMenu._mode === "trade" || SummaryMenu._context === "factory")) {
            SummaryMenu._swapSlot = SummaryMenu._moveCursor;
            SummaryMenu._blink.frame = 0; SummaryMenu._blink.hidden = false;
          }
        } else {
          const slotA = SummaryMenu._swapSlot;
          const slotB = SummaryMenu._moveCursor;
          SummaryMenu._swapSlot = null;
          if (slotA !== slotB) Pokemon.swapMoves(mon, slotA, slotB);
        }
      } else if (input.wasPressed("b")) {
        if (swapping) {
          SummaryMenu._swapSlot = null;
        } else {
          // pokefirered/src/pokemon_summary_screen.c:3640
          if (pos === 4) SummaryMenu._moveCursor = 1;
          start_slide("back", PAGE_MOVES, -1);
        }
      }
      return;
    }

    // pokefirered/src/pokemon_summary_screen.c:1126
    if (page_flip_input(input, 1)) {
      if (SummaryMenu._page < PAGE_MOVES) {
        se(5);
        start_slide("page", SummaryMenu._page + 1, 1);
      }
    } else if (page_flip_input(input, -1)) {
      if (SummaryMenu._page > PAGE_INFO) {
        se(5);
        start_slide("page", SummaryMenu._page - 1, -1);
      }
    } else if (input.wasPressed("up")) {
      change_mon(-1);
    } else if (input.wasPressed("down")) {
      change_mon(1);
    } else if (input.wasPressed("a")) {
      // pokefirered/src/pokemon_summary_screen.c:1178
      if (SummaryMenu._page === PAGE_INFO) {
        se(5);
        SummaryMenu.close();
      } else if (SummaryMenu._page === PAGE_MOVES) {
        se(5);
        start_slide("detail", PAGE_MOVES_INFO, 1);
      }
    } else if (input.wasPressed("b") || input.wasPressed("start")) {
      SummaryMenu.close();
    }
  },

  // pokefirered/src/pokemon.c:5834, :5210-5216
  // Lua: summary_menu.lua:643
  dexNumber(species: unknown, session?: any): number | null {
    const sp = tonumber(species) ?? 0;
    const nat = (sp !== 0 && Pokemon.national ? Pokemon.national(sp) : null) || 0;
    if (nat !== 0 && !PokedexData.isNationalUnlocked(session)) {
      // pokeemerald/src/pokemon.c:5685
      if (!Dex.nationalInRegional(nat, undefined)) return null;
      return Dex.regionalNumber(sp, undefined) ?? nat;
    }
    return nat;
  },

  // pokefirered/src/pokemon_summary_screen.c:2088
  // Lua: summary_menu.lua:655
  dexNoText(mon: any, session?: any): string {
    const nat = SummaryMenu.dexNumber(Pokemon.speciesOf(mon), session);
    if (nat == null) return RomText.plain("gText_PokeSum_DexNoUnknown");
    return format("%03d", nat);
  },

  // pokefirered/src/pokemon_summary_screen.c:4736
  // Lua: summary_menu.lua:662
  showsPokerusIcon(mon: any): boolean {
    if (!mon) return false;
    return !Pokemon.hasPokerus(mon) && Pokemon.hasHadPokerus(mon);
  },

  // pokefirered/src/pokemon_summary_screen.c:4108
  // Lua: summary_menu.lua:668
  ballIdOf(mon: any): any {
    if (!mon || Pokemon.isEgg(mon)) return BallOpen.ballIdForItem(0);
    return BallOpen.ballIdForItem(mon.pokeball);
  },

  // pokefirered/src/pokemon_summary_screen.c:1615
  // Lua: summary_menu.lua:701
  leftPaneSprites(page: number, mode: any): Record<string, { x: number; y: number } | undefined> {
    const at = (key: string, fx: number, fy: number): { x: number; y: number } => {
      const [x, y] = cxy(key, fx, fy);
      return { x, y };
    };
    if (page === PAGE_MOVES_INFO) {
      return {
        icon: at("monIcon", 8, 16),
        // pokefirered/src/pokemon_summary_screen.c:1976
        status: (mode === "select_move") ? at("statusMovesInfo", 0, 41) : undefined,
        shiny: at("shinyStarMovesInfo", 4, 20),
        pokerus: at("pokerus", 110, 88),
      };
    }
    return {
      pic: at("monPic", 60, 65),
      ball: at("ball", 106, 88),
      markings: at("markings", 4, 87),
      status: at("status", 0, 34),
      shiny: at("shinyStar", 102, 36),
      pokerus: at("pokerus", 110, 88),
    };
  },

  // pokefirered/src/pokemon_summary_screen.c:2148
  // Lua: summary_menu.lua:835
  rightAlign(str: unknown, width: number): number {
    return width - tostring(str).length * 6;
  },

  // pokefirered/src/pokemon_summary_screen.c:2532
  // Lua: summary_menu.lua:922
  ppColorIndex(curIn: unknown, maxIn: unknown, hasMove: boolean): number {
    const cur = tonumber(curIn) ?? 0, max = tonumber(maxIn) ?? 0;
    if (!hasMove || cur === max) return 0;
    if (cur === 0) return 3;
    if (max === 3) {
      if (cur === 2) return 2; else if (cur === 1) return 1;
      return 0;
    } else if (max === 2) {
      return (cur === 1) ? 1 : 0;
    }
    if (cur <= Math.floor(max / 4)) return 2;
    if (cur <= Math.floor(max / 2)) return 1;
    return 0;
  },

  // Lua: summary_menu.lua:1116
  controlsString: undefined as unknown as (page: number, isEgg: boolean) => string,

  // pokefirered/src/pokemon_summary_screen.c:3091
  // Lua: summary_menu.lua:1140
  slideOffset(frame: number | undefined, incoming: boolean): number {
    const hofs = Math.min(Math.max(frame ?? 0, 0), SLIDE_FRAMES) * SLIDE_STEP;
    return incoming ? (240 - hofs) : hofs;
  },

  // Lua: summary_menu.lua:1172
  flipStep(): number {
    const s = SummaryMenu._slide;
    const T = FLIP_TIMING[s.kind] ?? FLIP_TIMING.page;
    return Math.min(Math.max((s.frame || 0) - T.delay!, 0), SLIDE_FRAMES);
  },

  // Lua: summary_menu.lua:1251
  draw(): void {
    if (!SummaryMenu.open) return;
    const mon = current_mon();
    if (!mon) return;

    const page = SummaryMenu._page;
    const isEgg = Pokemon.isEgg(mon);
    // pokefirered/src/pokemon_summary_screen.c:2009
    const shiny = (!isEgg) && SummaryData.isShiny(mon);
    const s = SummaryMenu._slide;

    if (s.active && page !== PAGE_EGG) {
      if (s.kind === "page") {
        draw_page_flip(mon, shiny);
      } else {
        draw_detail_flip(mon, shiny);
      }
      return;
    }

    draw_page_bg(page, shiny);
    draw_top_bar_text(page, isEgg);
    if (page === PAGE_EGG) {
      draw_page_egg(mon);
      return;
    }
    draw_header(mon, page !== PAGE_MOVES_INFO);
    draw_left_sprites(mon, page);
    draw_page_text(mon, page);
  },
};

// pcall(function() require("src.core.game3.audio").playSe(id) end)
function se(id: unknown): void {
  try { Audio.playSe(id); } catch { /* pcall */ }
}

// Lua: summary_menu.lua:83
function current_mon(): any {
  if (!SummaryMenu._party) return null;
  return SummaryMenu._party[SummaryMenu._cursor];
}

// Lua: summary_menu.lua:88
function party_count(): number {
  return len(SummaryMenu._party ?? seq());
}

// pokefirered/src/pokemon_summary_screen.c:5180
// Lua: summary_menu.lua:93
function play_mon_cry(): void {
  const mon = current_mon();
  if (!mon || Pokemon.isEgg(mon)) return;
  const species = Pokemon.speciesOf(mon);
  if (!species) return;
  // pcall(require, "src.core.game3.audio"): the module is always there.
  if (Audio && Audio.playCry) {
    Audio.playCry(species);
  }
}

// pokefirered/src/pokemon_summary_screen.c:2297
// Lua: summary_menu.lua:105
function power_accuracy(mdef: any): [string, string] {
  const none = RomText.plain("gText_ThreeHyphens");
  const power = (mdef && mdef.power && mdef.power > 1) ? tostring(mdef.power) : none;
  const acc = (mdef && mdef.accuracy && mdef.accuracy > 0) ? tostring(mdef.accuracy) : none;
  return [power, acc];
}

// Lua: summary_menu.lua:112
function moves_for_mon(mon: any): LuaTable {
  if (!mon) return seq();
  const out: LuaTable = seq();
  const rawMoves = mon.moves ?? seq();
  const rawPp = mon.pp ?? seq();

  for (let i = 1; i <= 4; i++) {
    const entry = rawMoves[i];
    let moveId: any, pp: any, maxPp: any, mdef: any;
    if (entry != null && typeof entry === "object") {
      moveId = entry.id ?? entry.move ?? entry.moveId ?? entry.num ?? entry.name ?? entry[1];
      pp = entry.pp;
    } else {
      moveId = entry;
      pp = rawPp[i];
    }

    if (moveId != null && moveId !== false && (typeof moveId !== "number" || moveId > 0) && moveId !== "" && moveId !== "-------") {
      mdef = Pokemon.battleMove(moveId);
      maxPp = tonumber(mon.maxPp && mon.maxPp[i]) ?? (mdef && mdef.pp) ?? 5;
      if (pp == null) pp = maxPp;
      let name: any = Pokemon.moveName(moveId);
      if (!name || name === "" || match(name, "^MOVE ") != null) {
        name = (mdef && mdef.name) ?? name ?? Strings("MOVE %s", tostring(moveId));
      }
      const mType = (mdef && (mdef.type ?? mdef.kind)) ?? "NORMAL";
      const [power, acc] = power_accuracy(mdef);
      out[i] = {
        id: moveId,
        name,
        pp,
        maxPp,
        type: mType,
        power,
        accuracy: acc,
      };
    }
  }

  if (SummaryMenu._mode === "select_move" && SummaryMenu._moveToLearn) {
    let newId: any = tonumber(SummaryMenu._moveToLearn);
    if (newId == null && typeof SummaryMenu._moveToLearn === "string") {
      const C = Constants.of(SummaryMenu._playerState ?? SummaryMenu._session);
      newId = C && C.id("moves", SummaryMenu._moveToLearn);
    }
    const battleMoveId = (Pokemon as any).battleMoveId;
    if (newId == null && typeof SummaryMenu._moveToLearn === "string" && battleMoveId) {
      newId = battleMoveId(SummaryMenu._moveToLearn);
    }
    newId = newId ?? SummaryMenu._moveToLearn;
    const mdef = Pokemon.battleMove(newId);
    let name: any = Pokemon.moveName(newId);
    if (!name || name === "" || match(name, "^MOVE ") != null) {
      name = (mdef && mdef.name) ?? name ?? Strings("MOVE %s", tostring(newId));
    }
    const maxPp = (mdef && mdef.pp) ?? 5;
    const mType = (mdef && (mdef.type ?? mdef.kind)) ?? "NORMAL";
    const [power, acc] = power_accuracy(mdef);
    out[5] = {
      id: newId,
      name,
      pp: maxPp,
      maxPp,
      type: mType,
      power,
      accuracy: acc,
    };
  }

  return out;
}

// Lua: summary_menu.lua:247
function change_mon(delta: number): void {
  const n = party_count();
  if (n <= 1) return;
  const nextCursor = mod(SummaryMenu._cursor - 1 + delta, n) + 1;
  SummaryMenu._cursor = nextCursor;
  SummaryMenu._moveCursor = 1;
  SummaryMenu._swapSlot = null;
  const mon = current_mon();
  if (mon && Pokemon.isEgg(mon)) {
    SummaryMenu._page = PAGE_EGG;
  } else if (SummaryMenu._page === PAGE_EGG) {
    SummaryMenu._page = PAGE_INFO;
  }
  SummaryMenu.resetPicBounce();
  // pokefirered/src/pokemon_summary_screen.c:5153
  play_mon_cry();
}

// Lua: summary_menu.lua:265
function start_slide(kind: SlideKind, newPage: number, dir: number): void {
  if (SummaryMenu._page === newPage) return;
  SummaryMenu._slide.active = true;
  SummaryMenu._slide.kind = kind;
  SummaryMenu._slide.direction = dir;
  SummaryMenu._slide.frame = 0;
  SummaryMenu._slide.prevPage = SummaryMenu._page;
  SummaryMenu._page = newPage;
  SummaryMenu._swapSlot = null;
}

// Lua: summary_menu.lua:276
function ailment_blocks_bounce(ailment: number): boolean {
  return ailment !== 0 && ailment !== 6;
}

// pokefirered/src/pokemon_summary_screen.c:3916
// Lua: summary_menu.lua:306
function step_pic_bounce(): void {
  const b = SummaryMenu._bounce;
  if (b.count >= 2) return;
  const m = SummaryChrome.manifest();
  const deltas = m && m.monPicBounce && m.monPicBounce[b.vigor];
  if (!deltas || len(deltas) === 0) return;
  const ready = b.delay >= 2;
  b.delay = b.delay + 1;
  if (!ready) return;
  b.anim = b.anim + 1;
  b.dy = b.dy + (deltas[b.anim] ?? 0);
  if (b.anim >= len(deltas)) {
    b.anim = 0;
    b.count = b.count + 1;
  }
  b.delay = 0;
}

// pokefirered/src/pokemon_summary_screen.c:3956
// Emerald's summary has no sEggPicShake table
// Lua: summary_menu.lua:326
function step_egg_shake(): void {
  const b = SummaryMenu._bounce;
  if (b.count >= 2) return;
  const m = SummaryChrome.manifest();
  const deltas = m && m.eggPicShake && m.eggPicShake[b.vigor + 1];
  if (!deltas || len(deltas) === 0) return;
  const ready = b.delay >= EGG_SHAKE_DELAY[b.vigor]!;
  b.delay = b.delay + 1;
  if (!ready) return;
  b.anim = b.anim + 1;
  b.dx = b.dx + (deltas[b.anim] ?? 0);
  if (b.anim >= len(deltas)) {
    b.anim = 0;
    b.delay = 0;
    b.count = b.count + 1;
  }
}

// pokefirered/src/pokemon_summary_screen.c:4247
// Lua: summary_menu.lua:345
function step_swap_blink(): void {
  const bl = SummaryMenu._blink;
  if (SummaryMenu._swapSlot == null) {
    bl.frame = 0; bl.hidden = false;
    return;
  }
  bl.frame = bl.frame + 1;
  if (bl.frame > 60) {
    bl.hidden = !bl.hidden;
    bl.frame = 0;
  }
}

// Lua: summary_menu.lua:358
function step_frame(): void {
  const s = SummaryMenu._slide;
  if (s.active) {
    s.frame = s.frame + 1;
    if (s.frame >= FLIP_TIMING[s.kind].done!) s.active = false;
  }
  if (SummaryMenu._bounce.egg) step_egg_shake(); else step_pic_bounce();
  step_swap_blink();
}

// pokefirered/src/pokemon_summary_screen.c:3796
// Lua: summary_menu.lua:378
function select_move_step(moves: LuaTable, cur: number, dir: number): number {
  if (dir < 0) {
    if (cur <= 1) return 5;
    for (let i = cur - 1; i >= 1; i--) {
      if (moves[i] != null) return i;
    }
    return cur;
  }
  if (cur >= 5) return 1;
  for (let i = cur + 1; i <= 4; i++) {
    if (moves[i] != null) return i;
  }
  return 5;
}

// Lua: summary_menu.lua:426
function lr_mode(): boolean {
  // package.loaded["src.core.game3.runtime"]: always loaded here.
  const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
  if (session == null || typeof session !== "object") return false;
  return Options.lrMode(session);
}

// pokefirered/src/pokemon_summary_screen.c:1064
// Lua: summary_menu.lua:434
function page_flip_input(input: any, dir: number): boolean {
  const s = SummaryMenu._slide;
  if (s.queued === dir) {
    s.queued = null;
    return true;
  }
  // pokefirered/src/pokemon_summary_screen.c:1056
  if (s.active && s.direction !== dir) return false;
  if (dir > 0) {
    return input.wasPressed("right") || (lr_mode() && input.wasPressed("r")) ? true : false;
  }
  return input.wasPressed("left") || (lr_mode() && input.wasPressed("l")) ? true : false;
}

// Lua: summary_menu.lua:604
function draw_text(str: unknown, x: number, y: number, maxW: number, colorKey: string | Colors): void {
  const colors = (typeof colorKey === "object" && colorKey) || STAT_COLORS()[colorKey as string] || FrlgFont.COLOR.NORMAL;
  FrlgFont.draw(tostring(str ?? ""), x, y, {
    maxWidth: maxW,
    colors,
  });
}

// Lua: summary_menu.lua:612
function coords(): any {
  const m = SummaryChrome.manifest();
  return (m && m.coords) || {};
}

// Lua: summary_menu.lua:617
function move_slots(): LuaTable {
  const m = SummaryChrome.manifest();
  return (m && m.moveSlots) || seq();
}

// Lua: summary_menu.lua:622
function moves_info_coords(): any {
  const m = SummaryChrome.manifest();
  return (m && m.movesInfo) || {};
}

// Lua: summary_menu.lua:627
function cxy(key: string, fx?: number, fy?: number): [number, number] {
  const c = coords()[key];
  if (c) return [c.x ?? fx ?? 0, c.y ?? fy ?? 0];
  return [fx ?? 0, fy ?? 0];
}

// Lua: summary_menu.lua:633
function species_name(mon: any): string {
  const species = Pokemon.speciesOf(mon);
  if (Pokemon.name) {
    const n = Pokemon.name(species);
    if (n && n !== "") return n;
  }
  return Pokemon.displayName(mon);
}

// Lua: summary_menu.lua:674
function draw_ball_icon(mon: any): void {
  const [img, quad] = Ui.ballQuad(SummaryMenu.ballIdOf(mon), 0) as [Image | undefined, Quad | undefined];
  if (!img) return;
  G.setColor(1, 1, 1, 1);
  G.draw(img, quad, 106 - 8, 88 - 8);
}

// Lua: summary_menu.lua:683
function mon_no_flip(mon: any): boolean {
  const m = SummaryChrome.manifest();
  const nf = m && m.noFlip;
  return (nf && nf[tonumber(Pokemon.speciesOf(mon)) ?? -1]) ? true : false;
}

// Lua: summary_menu.lua:689
function draw_flipped(img: Image, quad: Quad | null | undefined, x: number, y: number, w: number, flip: boolean): void {
  if (flip) {
    if (quad) G.draw(img, quad, x + w, y, 0, -1, 1);
    else G.draw(img, x + w, y, 0, -1, 1);
  } else if (quad) {
    G.draw(img, quad, x, y);
  } else {
    G.draw(img, x, y);
  }
}

// Lua: summary_menu.lua:725
function draw_left_sprites(mon: any, page: number): void {
  const s = SummaryMenu.leftPaneSprites(page, SummaryMenu._mode);
  const flip = !mon_no_flip(mon);

  if (s.pic) {
    const front = Pokemon.monFrontPic(mon);
    if (front && front.image) {
      const iw = front.w ?? 64, ih = front.h ?? 64;
      G.setColor(1, 1, 1, 1);
      // pokefirered/src/pokemon_summary_screen.c:4037
      draw_flipped(front.image, null, s.pic.x - iw / 2, s.pic.y - ih / 2 + SummaryMenu._bounce.dy, iw, flip);
    }
  }
  if (s.icon) {
    const icon: any = Pokemon.monIcon(mon);
    if (icon && icon.image) {
      G.setColor(1, 1, 1, 1);
      // pokefirered/src/pokemon_summary_screen.c:4164
      draw_flipped(icon.image, icon.quads && icon.quads[0], s.icon.x, s.icon.y, icon.w ?? 32, flip);
    }
  }
  if (s.ball) {
    draw_ball_icon(mon);
  }
  if (s.markings) {
    // pokefirered/src/pokemon_summary_screen.c:4900
    SummaryChrome.drawMarkings(mon.markings, s.markings.x, s.markings.y);
  }
  const ailment = SummaryData.statusAilment(mon);
  if (s.status && ailment > 0) {
    SummaryChrome.drawStatusIcon(s.status.x, s.status.y, ailment);
  }
  if (s.shiny && SummaryData.isShiny(mon)) {
    SummaryChrome.drawShinyStar(s.shiny.x, s.shiny.y);
  }
  // pokefirered/src/pokemon_summary_screen.c:4736
  if (s.pokerus && SummaryMenu.showsPokerusIcon(mon)) {
    SummaryChrome.drawPokerus(s.pokerus.x, s.pokerus.y);
  }
}

// Lua: summary_menu.lua:767
function draw_header(mon: any, showLevel: boolean, dxIn?: number): void {
  const dx = dxIn ?? 0;
  if (dx >= 240) return;
  // Nickname + level + gender live in the left LVL_NICK strip (not the right pane).
  const nick = Pokemon.displayName(mon);
  const [nx, ny] = cxy("name", 40, 18);
  draw_text(nick, nx + dx, ny, 64, "NORMAL");

  // pokefirered/src/pokemon_summary_screen.c:2430
  if (showLevel) {
    const lv = tonumber(mon.level) ?? 1;
    const [lx, ly] = cxy("level", 4, 18);
    // src/pokemon_summary_screen.c:2137
    draw_text(RomText.plain("gText_Lv") + tostring(lv), lx + dx, ly, 36, "NORMAL");
  }

  const gender = SummaryData.gender(mon);
  let [gx, gy] = cxy("gender", 105, 18);
  gx = gx + dx;
  if (gender === "M") {
    FrlgFont.draw(MALE_SIGN, gx, gy, { colors: FrlgFont.COLOR.MALE, small: false });
  } else if (gender === "F") {
    FrlgFont.draw(FEMALE_SIGN, gx, gy, { colors: FrlgFont.COLOR.FEMALE, small: false });
  }
}

// Lua: summary_menu.lua:793
function draw_page_info(mon: any): void {
  const species = Pokemon.speciesOf(mon);
  const t1 = mon.type1 ?? (Pokemon.types && Pokemon.types(species) ? Pokemon.types(species)[1] : null) ?? "NORMAL";
  const t2 = mon.type2 ?? (Pokemon.types && Pokemon.types(species) ? Pokemon.types(species)[2] : null);

  const [dx, dy] = cxy("dexNo", 167, 21);
  draw_text(SummaryMenu.dexNoText(mon, SummaryMenu._playerState), dx, dy, 40, "NORMAL");

  const [sx, sy] = cxy("species", 167, 35);
  draw_text(species_name(mon), sx, sy, 64, "NORMAL");

  const [t1x, t1y] = cxy("type1", 167, 51);
  SummaryChrome.drawTypeBadge(t1, t1x, t1y);
  if (t2 != null && t2 !== false && t2 !== t1 && t2 !== "") {
    const [t2x, t2y] = cxy("type2", 203, 51);
    SummaryChrome.drawTypeBadge(t2, t2x, t2y);
  }

  // package.loaded["src.core.game3.runtime"]: always loaded here.
  const pState = SummaryMenu._playerState
    ?? (Runtime && Runtime.getSession ? Runtime.getSession() : undefined);
  const otName = mon.otName ?? mon.ot ?? mon.originalTrainer ?? (pState ? (pState.name ?? pState.playerName) : null) ?? "RED";
  const [ox, oy] = cxy("otName", 167, 65);
  draw_text(otName, ox, oy, 60, "NORMAL");

  const otId = tonumber(mon.otId ?? mon.ot_id ?? mon.trainerId ?? (pState && (pState.trainerId ?? pState.id ?? pState.playerId))) ?? 0;
  const [ix, iy] = cxy("otId", 167, 80);
  draw_text(format("%05d", otId & 0xFFFF), ix, iy, 48, "NORMAL");

  const [itx, ity] = cxy("item", 167, 95);
  draw_text(SummaryMenu.heldItemText(mon), itx, ity, 64, "NORMAL");

  const memo = coords().memo ?? { x: 8, y: 115, w: 224 };
  const memoLines = SummaryData.formatTrainerMemo(mon, SummaryMenu._playerState,
    { enemyParty: SummaryMenu._enemyParty, owner: SummaryMenu._owner });
  let memoY = memo.y ?? 115;
  for (const [, line] of ipairs(memoLines)) {
    draw_text(line, memo.x ?? 8, memoY, memo.w ?? 224, "NORMAL");
    memoY = memoY + 14;
  }
}

// Lua: summary_menu.lua:839
function draw_skill_bars(mon: any, dx: number): void {
  const curHp = tonumber(mon.hp ?? mon.currentHp) ?? 0;
  const maxHp = tonumber(mon.maxHp ?? mon.maxhp) ?? 1;
  const bar = coords().hpBar ?? { x: 168, y: 32 };
  SummaryChrome.drawHpBar((bar.x ?? 168) + dx, bar.y ?? 32, curHp, maxHp);
  const prog = SummaryData.expProgress(mon);
  const expBar = coords().expBar ?? { x: 152, y: 128 };
  SummaryChrome.drawExpBar((expBar.x ?? 152) + dx, expBar.y ?? 128, prog.progressPercent);
}

// Lua: summary_menu.lua:849
function draw_page_skills(mon: any): void {
  const curHp = tonumber(mon.hp ?? mon.currentHp) ?? 0;
  const maxHp = tonumber(mon.maxHp ?? mon.maxhp) ?? 1;
  const [hx, hy] = cxy("hpText", 174, 20);
  const hpStr = format("%d/%d", curHp, maxHp);
  // pokefirered/src/pokemon_summary_screen.c:2170
  draw_text(hpStr, hx + SummaryMenu.rightAlign(hpStr, 63), hy, 63, "NORMAL");

  draw_skill_bars(mon, 0);

  const stats = seq(
    { val: mon.attack ?? mon.atk ?? 0, coord: "atk", fy: 38 },
    { val: mon.defense ?? mon.def ?? 0, coord: "def", fy: 51 },
    { val: mon.spAtk ?? mon.spatk ?? 0, coord: "spAtk", fy: 64 },
    { val: mon.spDef ?? mon.spdef ?? 0, coord: "spDef", fy: 77 },
    { val: mon.speed ?? mon.spe ?? 0, coord: "spd", fy: 90 },
  );

  for (const [, st] of ipairs<{ val: any; coord: string; fy: number }>(stats)) {
    const [x, y] = cxy(st.coord, 210, st.fy);
    const str = format("%d", tonumber(st.val) ?? 0);
    // pokefirered/src/pokemon_summary_screen.c:2502
    draw_text(str, x + SummaryMenu.rightAlign(str, 27), y, 27, "NORMAL");
  }

  const [lx, ly] = cxy("expPointsLabel", 74, 103);
  draw_text(RomText.plain("gText_PokeSum_ExpPoints"), lx, ly, 96, "NORMAL");
  const [nlx, nly] = cxy("nextLvLabel", 74, 116);
  draw_text(RomText.plain("gText_PokeSum_NextLv"), nlx, nly, 96, "NORMAL");

  const prog = SummaryData.expProgress(mon);
  const [ex, ey] = cxy("expTotal", 175, 103);
  const expStr = format("%d", prog.totalExp);
  // pokefirered/src/pokemon_summary_screen.c:2507
  draw_text(expStr, ex + SummaryMenu.rightAlign(expStr, 63), ey, 63, "NORMAL");
  const [nx, ny] = cxy("expNext", 175, 116);
  const nextStr = format("%d", prog.expNeeded);
  draw_text(nextStr, nx + SummaryMenu.rightAlign(nextStr, 63), ny, 63, "NORMAL");

  // Party stores ability as numeric id (e.g. 65 = OVERGROW); resolve to name.
  let abilityId: number | null | undefined = tonumber(mon.abilityId) ?? tonumber(mon.ability);
  let ability: any = mon.abilityName;
  if (typeof mon.ability === "string" && mon.ability !== "" && tonumber(mon.ability) == null) {
    ability = mon.ability;
  }
  if ((!ability || ability === "") && abilityId != null && abilityId > 0) {
    ability = Pokemon.abilityName(abilityId);
  }
  if (!ability || ability === "") {
    const aid = Pokemon.abilityId ? Pokemon.abilityId(Pokemon.speciesOf(mon), mon.personality ?? 0) : undefined;
    if (aid != null && aid > 0) {
      abilityId = aid;
      ability = Pokemon.abilityName(aid);
    }
  }
  ability = ability ?? EM_DASH;
  const [ax, ay] = cxy("abilityName", 74, 129);
  // No registry renames abilities; a translation reaches the name through Strings().
  draw_text(Strings(tostring(ability)), ax, ay, 80, "NORMAL");
  const desc = SummaryData.abilityDescription(abilityId, tostring(ability));
  const ad = coords().abilityDesc ?? { x: 10, y: 143, w: 232 };
  draw_text(desc, ad.x ?? 10, ad.y ?? 143, ad.w ?? 232, "NORMAL");
}

// pret prints each move name at x 3 of POKESUM_WIN_MOVES_3, a 10-tile window
// starting at tile 20 (pokemon_summary_screen.c:857, :2543), so a name has up
// to that window's right edge -- the edge of the screen -- which is 77 px from
// the usual pen at 163.  The cart's own names reach 72 px (SKY UPPERCUT,
// FRENZY PLANT), and a translated one can use the rest.
// Lua: summary_menu.lua:919
const MOVE_NAME_RIGHT = (20 + 10) * 8;

// Lua: summary_menu.lua:937 (a weak-keyed table)
const moveColorCache = new WeakMap<object, Record<number, Colors>>();

// pokefirered/src/pokemon_summary_screen.c:645
// Lua: summary_menu.lua:940
function move_text_colors(idx: number): Colors | "NORMAL" {
  const m = SummaryChrome.manifest();
  const src = m && m.moveTextColors;
  const c = src && src[idx];
  if (!c) return "NORMAL";
  let cache = moveColorCache.get(src);
  if (!cache) { cache = {}; moveColorCache.set(src, cache); }
  if (!cache[idx]) {
    const rgb = (t: any): number[] => [(t[1] ?? 0) / 255, (t[2] ?? 0) / 255, (t[3] ?? 0) / 255, 1];
    cache[idx] = { fg: rgb(c.fg), shadow: rgb(c.shadow), bg: FrlgFont.STDPAL[0] };
  }
  return cache[idx]!;
}

// Lua: summary_menu.lua:954
function draw_move_row(slot: any, m: Move | null | undefined): void {
  const colorIdx = SummaryMenu.ppColorIndex(m && m.pp, m && m.maxPp, m != null);
  const colors = move_text_colors(colorIdx);
  if (m) {
    SummaryChrome.drawTypeBadge(m.type, slot.typeX, slot.typeY);
  }
  // pokefirered/src/pokemon_summary_screen.c:2543
  draw_text(m ? m.name : RomText.plain("gText_PokeSum_OneHyphen"), slot.nameX, slot.nameY,
    MOVE_NAME_RIGHT - slot.nameX, move_text_colors(0));
  draw_text(RomText.plain("gText_PokeSum_PP"), slot.ppX, slot.ppY, 16, colors);
  if (!m) {
    // pokefirered/src/pokemon_summary_screen.c:2263
    draw_text(RomText.plain("gText_PokeSum_TwoHyphens"), slot.ppX + 9, slot.ppY, 24, colors);
    return;
  }
  const cur = tostring(m.pp), max = tostring(m.maxPp);
  // pokefirered/src/pokemon_summary_screen.c:2571
  draw_text(cur, slot.ppX + 10 + SummaryMenu.rightAlign(cur, 12), slot.ppY, 24, colors);
  draw_text(RomText.plain("gText_Slash"), slot.ppX + 22, slot.ppY, 8, colors);
  draw_text(max, slot.ppX + 28 + SummaryMenu.rightAlign(max, 12), slot.ppY, 24, colors);
}

interface MoveParts { rows5?: boolean; cursor?: boolean; types?: boolean; bottom?: boolean }

// Lua: summary_menu.lua:976
function draw_page_moves(mon: any, isDetail: boolean, partsIn?: MoveParts): void {
  const moves = moves_for_mon(mon);
  const slots = move_slots();
  const parts: MoveParts = partsIn ?? (isDetail ? { rows5: true, cursor: true, types: true, bottom: true } : {});

  for (let i = 1; i <= (parts.rows5 ? 5 : 4); i++) {
    const slot = slots[i] ?? {
      nameX: 163, nameY: 21 + (i - 1) * 28,
      typeX: 123, typeY: 21 + (i - 1) * 28,
      ppX: 196, ppY: 32 + (i - 1) * 28,
    };
    if (i <= 4) {
      draw_move_row(slot, moves[i]);
    } else if (SummaryMenu._mode === "select_move" && !SummaryMenu._forgetMove) {
      draw_move_row(slot, moves[5]);
    } else {
      // pokefirered/src/pokemon_summary_screen.c:2526
      draw_text(RomText.plain("gFameCheckerText_Cancel"), slot.nameX, slot.nameY, MOVE_NAME_RIGHT - slot.nameX, move_text_colors(0));
    }
  }

  if (parts.cursor) {
    if (!(SummaryMenu._swapSlot != null && SummaryMenu._blink.hidden)) {
      const curY = 18 + (SummaryMenu._moveCursor - 1) * 28;
      SummaryChrome.drawMoveSelectionCursor(120, curY, false);
    }
    if (SummaryMenu._swapSlot != null) {
      const swapY = 18 + (SummaryMenu._swapSlot - 1) * 28;
      SummaryChrome.drawMoveSelectionCursor(120, swapY, true);
    }
  }

  if (parts.types) {
    const species = Pokemon.speciesOf(mon);
    const types = Pokemon.types ? (Pokemon.types(species) ?? seq()) : seq();
    const t1 = mon.type1 ?? types[1] ?? "NORMAL";
    const t2 = mon.type2 ?? types[2];
    // pokefirered/src/pokemon_summary_screen.c:3375
    const [ax, ay] = cxy("movesInfoType1", 48, 35);
    SummaryChrome.drawTypeBadge(t1, ax, ay);
    if (t2 != null && t2 !== false && t2 !== t1 && t2 !== "") {
      const [bx, by] = cxy("movesInfoType2", 84, 35);
      SummaryChrome.drawTypeBadge(t2, bx, by);
    }
  }

  if (parts.bottom) {
    const selMove = moves[SummaryMenu._moveCursor] as Move | null | undefined;
    if (SummaryMenu._hmNotice) {
      const descBox = moves_info_coords().desc ?? { x: 7, y: 98, w: 112 };
      // pokefirered/src/strings.c:844
      draw_text(RomText.plain("gText_PokeSum_HmMovesCantBeForgotten"), descBox.x, descBox.y, descBox.w ?? 112, "NORMAL");
    } else if (selMove) {
      const mi = moves_info_coords();
      const power = mi.power ?? { x: 57, y: 57 };
      const accuracy = mi.accuracy ?? { x: 57, y: 71 };
      const descBox = mi.desc ?? { x: 7, y: 98, w: 112 };
      // pokefirered/src/pokemon_summary_screen.c:2297
      draw_text(selMove.power, power.x + SummaryMenu.rightAlign(selMove.power, 18), power.y, 32, "NORMAL");
      draw_text(selMove.accuracy, accuracy.x + SummaryMenu.rightAlign(selMove.accuracy, 18), accuracy.y, 32, "NORMAL");
      const desc = SummaryData.moveDescription(selMove.id, selMove.name);
      draw_text(desc, descBox.x, descBox.y, descBox.w ?? 112, "NORMAL");
    }
  }
}

// Lua: summary_menu.lua:1042
function draw_page_egg(mon: any): void {
  // pokefirered/src/pokemon_summary_screen.c:4016 MON_DATA_SPECIES_OR_EGG
  const species = Pokemon.speciesOrEgg(mon);
  // pokefirered/src/pokemon_summary_screen.c:2467
  const [sx, sy] = cxy("species", 167, 35);
  draw_text(RomText.plain("gText_EggNickname"), sx, sy, 64, "NORMAL");
  // pokefirered/src/pokemon_summary_screen.c:2495
  draw_text(SummaryData.eggHatchText(mon), 120 + 7, 16 + 45, 113, "NORMAL");

  const pic = coords().monPic ?? { x: 60, y: 65 };
  const cx = pic.x ?? 60, cy = pic.y ?? 65;
  const front = Pokemon.frontPic(species);
  if (front && front.image) {
    const iw = front.w ?? 64;
    const ih = front.h ?? 64;
    G.setColor(1, 1, 1, 1);
    const nf = SummaryChrome.manifest() && SummaryChrome.manifest().noFlip;
    // pokefirered/src/pokemon_summary_screen.c:4037
    draw_flipped(front.image, null, cx - iw / 2 + SummaryMenu._bounce.dx, cy - ih / 2, iw,
      !(nf && nf[tonumber(species) ?? -1]));
  }
  draw_ball_icon(mon);

  const memo = coords().memo ?? { x: 8, y: 115, w: 224 };
  const memoLines = SummaryData.formatTrainerMemo(mon, SummaryMenu._playerState,
    { enemyParty: SummaryMenu._enemyParty, owner: SummaryMenu._owner });
  let memoY = memo.y ?? 115;
  for (const [, line] of ipairs(memoLines)) {
    draw_text(line, memo.x ?? 8, memoY, memo.w ?? 224, "NORMAL");
    memoY = memoY + 14;
  }
}

// src/pokemon_summary_screen.c:2934
// Lua: summary_menu.lua:1076. Built on first use (RomText may not be
// initialised yet inside the ES import cycle when this module loads).
let PAGE_TITLES_T: Record<string, string | undefined> | undefined;
function PAGE_TITLES(): Record<string, string | undefined> {
  if (!PAGE_TITLES_T) {
    PAGE_TITLES_T = RomText.lazy({
      [PAGE_INFO]: "gText_PokeSum_PageName_PokemonInfo",
      [PAGE_SKILLS]: "gText_PokeSum_PageName_PokemonSkills",
      [PAGE_MOVES]: "gText_PokeSum_PageName_KnownMoves",
      [PAGE_MOVES_INFO]: "gText_PokeSum_PageName_KnownMoves",
      [PAGE_EGG]: "gText_PokeSum_PageName_PokemonInfo",
    });
  }
  return PAGE_TITLES_T;
}

// Lua: summary_menu.lua:1084
function summary_in_battle(): boolean {
  // package.loaded["src.core.game3.battle"]: always loaded here.
  return (Battle && Battle.isActive && Battle.isActive()) ? true : false;
}

// Lua: summary_menu.lua:1089
function get_controls_str(page: number, isEgg: boolean): string {
  if (SummaryMenu._mode === "select_move") {
    // src/pokemon_summary_screen.c:2954
    if (summary_in_battle()) {
      return RomText.plain("gText_PokeSum_Controls_Pick");
    }
    return RomText.plain("gText_PokeSum_Controls_PickSwitch");
  }
  if (isEgg) {
    return RomText.plain("gText_PokeSum_Controls_Cancel");
  }
  if (page === PAGE_INFO) {
    return RomText.plain("gText_PokeSum_Controls_PageCancel");
  } else if (page === PAGE_SKILLS) {
    return RomText.plain("gText_PokeSum_Controls_Page");
  } else if (page === PAGE_MOVES) {
    return RomText.plain("gText_PokeSum_Controls_PageDetail");
  } else if (page === PAGE_MOVES_INFO) {
    // src/pokemon_summary_screen.c:1365
    if (summary_in_battle() || SummaryMenu._mode === "trade") {
      return RomText.plain("gText_PokeSum_Controls_Pick");
    }
    return RomText.plain("gText_PokeSum_Controls_PickSwitch");
  }
  return RomText.plain("gText_PokeSum_Controls_Page");
}

SummaryMenu.controlsString = get_controls_str;

// Lua: summary_menu.lua:1118
function draw_top_bar_text(page: number, isEgg: boolean, dxIn?: number): void {
  const dx = dxIn ?? 0;
  if (dx >= 240) return;
  const title = PAGE_TITLES()[page];
  FrlgFont.draw(title, 4 + dx, 1, {
    colors: FrlgFont.COLOR.WHITE,
    small: false,
  });

  const ctrl = get_controls_str(page, isEgg);
  PokedexChrome.drawControlInfo(ctrl, 236 + dx, 1);
}

// Lua: summary_menu.lua:1131
const PAGE_LAYERS: Record<number, { bg3: string; progress: string; layer: string }> = {
  [PAGE_INFO]: { bg3: "info", progress: "info", layer: "info" },
  [PAGE_SKILLS]: { bg3: "info", progress: "skills", layer: "skills" },
  [PAGE_MOVES]: { bg3: "info", progress: "moves", layer: "moves" },
  [PAGE_MOVES_INFO]: { bg3: "moves", progress: "moves_info", layer: "moves_info" },
  [PAGE_EGG]: { bg3: "info", progress: "egg", layer: "egg" },
};

// pokefirered/src/pokemon_summary_screen.c:1929
// Lua: summary_menu.lua:1146
function draw_page_bg(page: number, shiny: boolean): void {
  const L = PAGE_LAYERS[page] ?? PAGE_LAYERS[PAGE_INFO]!;
  let progress = L.progress;
  if (page === PAGE_MOVES_INFO && SummaryMenu._mode === "select_move") {
    progress = "moves_info_select";
  }
  SummaryChrome.drawBg3(L.bg3, shiny);
  SummaryChrome.drawProgress(progress, shiny);
  if (page === PAGE_MOVES_INFO) {
    SummaryChrome.drawLayer("moves", 0, shiny);
  }
  SummaryChrome.drawLayer(L.layer, 0, shiny);
}

// Lua: summary_menu.lua:1160
function draw_page_text(mon: any, page: number): void {
  if (page === PAGE_INFO) {
    draw_page_info(mon);
  } else if (page === PAGE_SKILLS) {
    draw_page_skills(mon);
  } else if (page === PAGE_MOVES) {
    draw_page_moves(mon, false);
  } else if (page === PAGE_MOVES_INFO) {
    draw_page_moves(mon, true);
  }
}

// pokefirered/src/pokemon_summary_screen.c:1233
// Lua: summary_menu.lua:1179
function draw_page_flip(mon: any, shiny: boolean): void {
  const s = SummaryMenu._slide;
  const T = FLIP_TIMING.page;
  const from = s.prevPage, to = SummaryMenu._page;
  const toL = PAGE_LAYERS[to]!, fromL = PAGE_LAYERS[from]!;
  const step = SummaryMenu.flipStep();
  const swapped = s.frame >= T.header!;
  SummaryChrome.drawBg3("info", shiny);
  SummaryChrome.drawProgress((swapped ? toL : fromL).progress, shiny);
  let toX = 0;
  if (s.direction > 0) {
    SummaryChrome.drawLayer(toL.layer, 0, shiny);
    // pokefirered/src/pokemon_summary_screen.c:1665
    if (to === PAGE_SKILLS) draw_skill_bars(mon, 0);
    SummaryChrome.drawLayer(fromL.layer, SummaryMenu.slideOffset(step, false), shiny);
  } else {
    SummaryChrome.drawLayer(fromL.layer, 0, shiny);
    toX = SummaryMenu.slideOffset(step, true);
    SummaryChrome.drawLayer(toL.layer, toX, shiny);
    // pokefirered/src/pokemon_summary_screen.c:3027
    if (to === PAGE_SKILLS) draw_skill_bars(mon, toX);
  }
  // pokefirered/src/pokemon_summary_screen.c:3171
  if (swapped) {
    draw_top_bar_text(to, false, toX);
    draw_header(mon, true, toX);
  } else {
    draw_top_bar_text(from, false, 0);
    draw_header(mon, true, 0);
  }
  draw_left_sprites(mon, to);
  // pokefirered/src/pokemon_summary_screen.c:1310
  if (s.frame >= T.text!) draw_page_text(mon, to);
}

// pokefirered/src/pokemon_summary_screen.c:1332
// Lua: summary_menu.lua:1215
function draw_detail_flip(mon: any, shiny: boolean): void {
  const s = SummaryMenu._slide;
  const T = FLIP_TIMING[s.kind];
  const f = s.frame;
  const incoming = s.kind === "detail";
  let detailBg: boolean;
  if (incoming) detailBg = f >= T.bg!; else detailBg = f < T.bg!;
  SummaryChrome.drawBg3(detailBg ? "moves" : "info", shiny);
  SummaryChrome.drawProgress(detailBg ? "moves_info" : "moves", shiny);
  SummaryChrome.drawLayer("moves", 0, shiny);
  const layerX = SummaryMenu.slideOffset(SummaryMenu.flipStep(), incoming);
  if (layerX < 240) SummaryChrome.drawLayer("moves_info", layerX, shiny);

  if (f < T.header!) {
    draw_top_bar_text(s.prevPage, false, 0);
    draw_header(mon, s.prevPage !== PAGE_MOVES_INFO, 0);
  } else {
    draw_top_bar_text(SummaryMenu._page, false, incoming ? layerX : 0);
    // pokefirered/src/pokemon_summary_screen.c:1412
    if (f >= T.name!) draw_header(mon, SummaryMenu._page !== PAGE_MOVES_INFO, 0);
  }

  const before = f < T.hide!, after = f >= T.show!;
  if (before) {
    draw_left_sprites(mon, s.prevPage);
  } else if (after) {
    draw_left_sprites(mon, SummaryMenu._page);
  }

  if (incoming) {
    draw_page_moves(mon, true, { rows5: f >= T.list5!, cursor: after, types: f >= T.name!, bottom: f >= T.bottom! });
  } else {
    draw_page_moves(mon, true, { rows5: f < T.list5!, cursor: before, types: before, bottom: f < T.bottom! });
  }
}

export default SummaryMenu;
