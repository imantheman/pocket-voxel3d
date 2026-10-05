// Port of gen1recomp src/ui/game3/message.lua (GPLv3 + additional terms; see LICENSE.md).
// game3 dialog TextPrinter (FRLG field message semantics).
// Variable-width latin_normal glyphs, typewriter pacing, explicit \\n only.

import { mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { fromArray, len, seq, type LuaTable } from "../platform/lt.ts";
import { Timer } from "../platform/timer.ts";
import { NotPortedError } from "../notported.ts";
import { TextIR, type Dialect } from "../core/scripting/text_ir.ts";
import { Display } from "../core/display.ts";
import { Runtime } from "../core/runtime.ts";
import { Options } from "../core/options.ts";
import { Space } from "../core/scripting/space.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { GameVersion } from "../../../import/gen3/game_version.ts";
import { FrlgFont, type Colors } from "./frlg_font.ts";
import { Chrome } from "./chrome.ts";

export interface ShowOpts {
  done?: () => void; stay?: boolean; hold?: boolean; frame?: string; sign?: boolean; battle?: boolean;
  colors?: Colors; gfxId?: unknown; npcColor?: number; speed?: unknown; session?: LuaTable; ctx?: LuaTable;
  [k: string]: unknown;
}

// pret sTextSpeedFrameDelays (options 0/1/2)
const SPEED_DELAYS = seq(8, 4, 1) as number[];

/**
 * Lua's `pcall(require, "src.import.CacheFs")` followed by a call into it:
 * while CacheFs is still a stub it stands for a failed require. Other errors raise.
 */
function viaCacheFs<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch (e) {
    if (e instanceof NotPortedError) return undefined;
    throw e;
  }
}

// Lua: message.lua:30
function liveSession(): LuaTable | undefined {
  // package.loaded["src.core.game3.runtime"]
  const s = Runtime ? Runtime.session : undefined;
  return s !== null && typeof s === "object" ? s : undefined;
}

const placeholderCache: Record<string, LuaTable> = {};

// pokeemerald/src/string_util.c:456
// Lua: message.lua:39
TextIR.setContextProvider((kind: string, dialect: Dialect, _ctx: unknown): unknown => {
  if (kind === "gender") {
    const s = liveSession();
    return s ? s.gender : undefined;
  }
  if (kind === "playerName") {
    const s = liveSession();
    const name = s ? (truthy(s.name) ? s.name : s.playerName) : undefined;
    return typeof name === "string" && name !== "" ? name : undefined;
  }
  if (kind === "rivalName" || kind === "stringVars") {
    // package.loaded["src.core.game3.scripting.space"]
    const Sp = Space as LuaTable;
    const vm = Sp ? Sp.vm : undefined;
    if (!truthy(vm)) return undefined;
    if (kind === "stringVars") return vm.ctx ? vm.ctx.stringVars : undefined;
    const a = vm.adapters;
    let r = a ? a.rivalName : undefined;
    if (typeof r === "function") r = r();
    return truthy(r) ? r : (vm.ctx ? vm.ctx.rivalName : undefined);
  }
  if (kind !== "placeholders" || !truthy(dialect.placeholders)) return undefined;
  const s = liveSession();
  const id = (s && truthy(s.version) ? s.version : undefined) ?? (GameVersion.get() || undefined) ?? "";
  const hit = placeholderCache[id];
  if (hit) return hit;
  const t = viaCacheFs(() => CacheFs.loadActive(dialect.placeholders as string));
  if (t !== null && typeof t === "object") {
    placeholderCache[id] = t;
    return t;
  }
  return undefined;
});

// Lua: message.lua:74
function split_pages(box: string): (string | null)[] {
  // TextIR.splitPages returns a 0-based JS array (text_ir's convention)
  const pages = fromArray(TextIR.splitPages(box));
  if (len(pages) === 0) pages[1] = box || "";
  return pages;
}

interface BrailleMod {
  countGlyphs(page: string): number;
  drawText(page: string, x: number, y: number, opts: LuaTable): void;
  drawCursor(): void;
}

// Lua: message.lua:80
function braille(): BrailleMod | undefined {
  // NOT FAITHFUL: src/ui/game3/braille.lua is outside the port's module set
  // (no stub exists); this is the Lua's failed pcall(require) path
  return undefined;
}

// Lua: message.lua:86
function beginPage(): void {
  const page = Message.currentPage() || "";
  const B = Message._frame === "braille" ? braille() : undefined;
  Message._total = B ? B.countGlyphs(page) : FrlgFont.countChars(page);
  Message._revealed = 0;
  Message._delay = 0;
  Message._arrowTicks = 0;
  Message._waiting = (Message._total === 0);
  Message._speedUp = false;
  // pokefirered/src/text_printer.c:91
  if (Message._frame === "braille") {
    Message._revealed = Message._total;
    Message._waiting = true;
  }
}

const bounceSeq = seq(0, 1, 2, 3, 2, 1) as number[];

export const Message = {
  open: false,
  _pages: undefined as (string | null)[] | undefined,
  _page: 1,
  _done: undefined as (() => void) | undefined,
  _stay: false,
  _hold: false,
  _held: false,
  _choice: undefined as unknown,
  _frame: "dialogue",
  _colors: undefined as Colors | undefined,
  _arrowTicks: 0,

  // Typewriter state for the current page.
  _revealed: 0,
  _total: 0,
  _delay: 0,
  _waiting: false, // page fully revealed; waiting for A/B
  _speedIdx: 1, // 0 slow / 1 mid / 2 fast
  _speedUp: false,

  // Lua: message.lua:102
  setFrame(kind: string): void {
    if (kind === "sign") {
      Message._frame = "sign";
    } else if (kind === "braille") {
      // pokefirered/src/scrcmd.c:1558
      Message._frame = "braille";
    } else if (kind === "battle") {
      Message._frame = "battle";
    } else if (kind === "voiceover") {
      // pokefirered/src/battle_bg.c:359
      Message._frame = "voiceover";
    } else {
      Message._frame = "dialogue";
    }
  },

  // Lua: message.lua:118
  frameKind(): string {
    return Message._frame || "dialogue";
  },

  // Lua: message.lua:122
  show(text: unknown, optsIn?: ShowOpts | (() => void)): any {
    let opts: ShowOpts;
    if (typeof optsIn === "function") {
      opts = { done: optsIn };
    } else if (optsIn === null || typeof optsIn !== "object") {
      opts = {};
    } else {
      opts = optsIn;
    }
    Message.open = true;
    Message._stay = opts.stay ? true : false;
    Message._hold = opts.hold ? true : false;
    Message._held = false;
    Message._done = opts.done;
    Message._choice = undefined;
    if (opts.frame === "sign" || opts.sign) {
      Message._frame = "sign";
    } else if (opts.frame === "braille") {
      // pokefirered/src/scrcmd.c:1558
      Message._frame = "braille";
    } else if (opts.frame === "voiceover") {
      // pokefirered/src/battle_controller_oak_old_man.c:2238
      Message._frame = "voiceover";
    } else if (opts.frame === "battle" || opts.battle) {
      Message._frame = "battle";
    } else {
      // Default field dialogue. Do not keep a sticky "battle" frame after fights
      // (battle Ui draws its own textbox; field msgs need Chrome.dialogueFrame).
      Message._frame = "dialogue";
    }

    // Resolve default ambient text colors
    if (opts.colors) {
      Message._colors = opts.colors;
    } else if (truthy(opts.gfxId)) {
      Message._colors = FrlgFont.colorForNpc(opts.gfxId);
    } else if (opts.npcColor != null) {
      if (opts.npcColor === FrlgFont.NPC_TEXT_COLOR.MALE) {
        Message._colors = FrlgFont.COLOR.MALE_NPC;
      } else if (opts.npcColor === FrlgFont.NPC_TEXT_COLOR.FEMALE) {
        Message._colors = FrlgFont.COLOR.FEMALE_NPC;
      } else {
        Message._colors = FrlgFont.COLOR.NORMAL;
      }
    } else if (Message._frame === "battle") {
      Message._colors = FrlgFont.COLOR.WHITE;
    } else {
      Message._colors = FrlgFont.COLOR.NORMAL;
    }

    // Prefer session options text speed when not overridden.
    const instant = tonumber(opts.speed) === 0;
    let speed = opts.speed;
    if (speed == null) {
      if (Options && Runtime && Runtime.getSession) {
        speed = Options.textSpeed(Runtime.getSession());
      }
    }
    // Also honor save-schema alias text_speed if Options path missed.
    if (speed == null && opts.session && opts.session.options) {
      speed = opts.session.options.text_speed ?? opts.session.options.textSpeed;
    }
    Message._speedIdx = tonumber(speed) ?? 1;
    if (Message._speedIdx < 0) Message._speedIdx = 0;
    if (Message._speedIdx > 2) Message._speedIdx = 2;

    const [, , dlgW] = Chrome.dialogueWindow();
    const maxW = (opts.frame === "battle" || opts.battle) ? 212 : dlgW * Display.TILE;
    const ctx = opts.ctx || {};
    if (!truthy(ctx.maxWidth)) ctx.maxWidth = maxW;
    // pokefirered/src/scrcmd.c:1566
    if (Message._frame === "braille") ctx.maxWidth = 4096;

    let plain: string;
    if (text !== null && typeof text === "object") {
      plain = TextIR.toTextBox(text as never, ctx);
    } else {
      const ir = TextIR.fromAscii(tostring(text != null ? text : ""));
      plain = TextIR.toTextBox(ir, ctx);
    }
    Message._pages = split_pages(plain);
    Message._page = 1;
    beginPage();
    if (instant) {
      Message.skipReveal();
    }
    return Message;
  },

  // Lua: message.lua:210
  showStay(text: unknown, opts?: ShowOpts): any {
    opts = opts || {};
    opts.stay = true;
    return Message.show(text, opts);
  },

  // Lua: message.lua:216
  currentPage(): string {
    if (!Message._pages) return "";
    return Message._pages[Message._page] ?? "";
  },

  // Lua: message.lua:221
  isOpen(): boolean {
    return Message.open;
  },

  // Lua: message.lua:225
  isWaiting(): boolean {
    return Message.open && Message._waiting;
  },

  // Lua: message.lua:229
  isTyping(): boolean {
    return Message.open && !Message._waiting;
  },

  /** Instantly finish the current page reveal. */
  // Lua: message.lua:234
  skipReveal(): void {
    if (!Message.open) return;
    Message._revealed = Message._total;
    Message._delay = 0;
    Message._waiting = true;
  },

  // Lua: message.lua:241
  advance(): void {
    if (!Message.open) return;
    if (truthy(Message._choice)) return;

    // While typing: first A/B finishes the page (pret canABSpeedUpPrint).
    if (!Message._waiting) {
      Message.skipReveal();
      return;
    }

    if (Message._page < len(Message._pages)) {
      Message._page = Message._page + 1;
      beginPage();
      return;
    }
    if (Message._stay) {
      return;
    }
    // pokefirered/src/battle_controller_oak_old_man.c:780
    if (Message._hold) {
      if (Message._held) return;
      Message._held = true;
      const done = Message._done;
      Message._done = undefined;
      if (done) done();
      return;
    }
    Message.close();
  },

  // Lua: message.lua:271
  isHeld(): boolean {
    return Message.open && Message._held === true;
  },

  // Lua: message.lua:275
  close(): void {
    const done = Message._done;
    Message.open = false;
    Message._pages = undefined;
    Message._page = 1;
    Message._done = undefined;
    Message._stay = false;
    Message._hold = false;
    Message._held = false;
    Message._choice = undefined;
    Message._revealed = 0;
    Message._total = 0;
    Message._waiting = false;
    if (done) done();
  },

  // Lua: message.lua:291
  closeStay(): boolean {
    if (!(Message.open && Message._stay)) return false;
    Message._done = undefined;
    Message.close();
    return true;
  },

  // pokefirered/src/main.c:480
  // Lua: message.lua:299
  reset(): boolean {
    Message._done = undefined;
    Message.close();
    return true;
  },

  // Lua: message.lua:305
  tick(): void {
    if (Message.open && Message._waiting) {
      Message._arrowTicks = (Message._arrowTicks ?? 0) + 1;
    }
    if (!Message.open || Message._waiting) return;
    if (Message._revealed >= Message._total) {
      Message._waiting = true;
      return;
    }
    // Held A/B: zero inter-glyph delay (canABSpeedUpPrint).
    if (Message._speedUp) {
      Message._delay = 0;
    }
    if (Message._delay > 0) {
      Message._delay = Message._delay - 1;
      return;
    }
    Message._revealed = Message._revealed + 1;
    if (Message._revealed >= Message._total) {
      Message._waiting = true;
    } else {
      let d = SPEED_DELAYS[Message._speedIdx + 1] ?? 4;
      // Match AddTextPrinter quirk: nonzero speed is stored decremented.
      if (d > 0) d = d - 1;
      Message._delay = Message._speedUp ? 0 : d;
    }
  },

  /** Hold A/B to run at fast speed (field message canABSpeedUpPrint). */
  // Lua: message.lua:334
  setSpeedUp(held: unknown): void {
    Message._speedUp = truthy(held) ? true : false;
  },

  /** Draw dialogue frame + text (and optional prompt). */
  // Lua: message.lua:339
  draw(): void {
    if (!Message.open) return;
    if (Message._frame === "sign") {
      Chrome.signFrame();
    } else if (Message._frame === "voiceover") {
      // pokefirered/src/battle_controller_oak_old_man.c:2238
      Chrome.dialogueFrame();
    } else if (Message._frame === "battle") {
      // Battle textbox chrome is drawn by battle Ui; text only here.
    } else {
      Chrome.dialogueFrame();
    }
    Message.drawText();
  },

  /**
   * Draw dialogue text (and optional prompt) into the content window.
   * Caller draws frame first unless using Message.draw().
   */
  // Lua: message.lua:356
  drawText(): void {
    if (!Message.open) return;
    const page = Message.currentPage() || "";
    let baseX: number, baseY: number, maxW: number;
    if (Message._frame === "battle") {
      // Window at tile (1,15)=px(8,120); printer x=2,y=2 → (10,122).
      // Panel chrome now drawn from y=112.
      [baseX, baseY, maxW] = [10, 122, 224];
    } else {
      const [L, Top, W] = Chrome.dialogueWindow();
      baseX = L * Display.TILE;
      baseY = Top * Display.TILE + 1;
      maxW = W * Display.TILE;
    }
    if (Message._frame === "braille") {
      // pokefirered/src/scrcmd.c:1566
      const B = braille();
      if (B) {
        B.drawText(page, baseX, baseY, {
          maxWidth: maxW,
          limitChars: Message._revealed,
          colors: Message._colors || FrlgFont.COLOR.NORMAL,
        });
        B.drawCursor();
        return;
      }
    }

    const [, endX, endY] = FrlgFont.draw(page, baseX, baseY, {
      maxWidth: maxW,
      limitChars: Message._revealed,
      colors: (Message._frame === "battle") ? FrlgFont.COLOR.WHITE : (Message._colors || FrlgFont.COLOR.NORMAL),
    });

    const rse = Chrome.arrowSpec();
    if (rse) {
      // pokeemerald/src/text.c:792
      if (Message._waiting && !Message._held && (truthy(rse.lastPage) || Message._page < len(Message._pages))) {
        const n = Math.floor((Message._arrowTicks ?? 0) / ((rse.delay ?? 0) + 1));
        Chrome.promptArrow(endX ?? baseX, endY ?? baseY, n);
      }
      return;
    }
    if (Message._waiting && !Message._stay && !Message._held) {
      const t = Timer.getTime() || 0;
      // Red arrow has 4 vertical bounce frames (0..3) in down_arrows.png
      const frame = bounceSeq[1 + mod(Math.floor(t * 8), len(bounceSeq))] ?? 0;

      let ax = (endX ?? (baseX + 16)) + 2;
      const ay = (endY ?? baseY);
      // Clamp arrow within the dialog panel
      if (ax + 10 > baseX + maxW) {
        ax = baseX + maxW - 10;
      }
      Chrome.promptArrow(ax, ay, frame);
    }
  },
};

export default Message;
