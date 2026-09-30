// gen1recomp src/render/TextBox.lua (bdfac727): the dialogue box --
// pagination, the typewriter, the ▼ wait, line scroll, pauses, the YES/NO
// and money boxes, auto-closing and staying boxes, and text tokens.
//
// A state on the stack like any screen. Drawing goes through Chrome and
// Font onto the Gold screen; the box sits in a sea of holes, so the world
// shows above it. The one-line scroll (ScrollTextUpOneLine) moves the top
// line by pixels, which lands its glyphs off the grid: the Gold screen
// draws those as objects for the four frames the scroll lasts.
//
// Lua pages/lines/codes were 1-based; here pages, lines and codes are
// 0-based arrays and pageIndex/lineIndex stay 1-based counters, so each
// `this.pages[this.pageIndex - 1]` reads as the Lua's `self.pages[self.pageIndex]`.

import G from "../../platform/screen.ts";
import { Chrome } from "../../ui/Chrome.ts";
import { UIVisibility } from "../battle/UIVisibility.ts";
import { Sound } from "../core/Sound.ts";
import { Timing } from "../core/Timing.ts";
import { Tokens, type TokenHandler } from "../script/Tokens.ts";
import { ChoiceBox } from "../ui/ChoiceBox.ts";
import { Theme } from "../ui/Theme.ts";
import { Font } from "./Font.ts";

// TextBox.lua:18-24
const BOX_TX = 0;
const BOX_TY = 12;
const BOX_TW = 20;
const BOX_TH = 6;
const MAX_COLS = 18;
const NAME_DELAYS: Record<string, number> = { FAST: 1, MID: 3, SLOW: 5 };
const PAUSE_FRAMES = 30;

type Pages = string[][] & { contBefore?: boolean[][] };

interface SoundSrc {
  isPlaying?(): boolean;
  stop?(): void;
}

export interface AutoOpts {
  wait?: boolean;
  delay?: number;
  overlap?: number;
  sound?: (() => SoundSrc | null | undefined) | null;
  tick?: () => void;
  afterSound?: () => void;
  onOverlap?: () => void;
  promptFirst?: boolean;
}

export interface TextBoxOpts {
  choice?: (yes: boolean) => void;
  defaultNo?: boolean;
  noSound?: boolean;
  choiceLabels?: [string, string];
  choiceBox?: { tx: number; ty: number; tw: number; th: number; firstItem?: number };
  money?: () => number;
  moneyWithChoice?: boolean;
  auto?: AutoOpts | true;
  stay?: { prompt?: boolean; onShown?: () => void };
  preSound?: () => SoundSrc | null | undefined;
  sfxWait?: boolean;
  waitButton?: boolean;
  instant?: boolean;
  pauseSounds?: Record<number, string | (() => SoundSrc | null | undefined)>;
  pauseSoundWait?: boolean;
}

const snd = Sound as unknown as {
  play(data: unknown, name: string): SoundSrc | null | undefined;
  playPress?(data: unknown): void;
  waitFrames?(src: unknown): number;
  sfxBusy?(): boolean;
};

function sfxWaitFrames(src: unknown): number {
  if (!snd.waitFrames) return 180;
  return snd.waitFrames(src);
}

function sfxWaitStep(game: any): number {
  let speed = game?.logicSpeed ? game.logicSpeed() : 1;
  if (typeof speed !== "number" || Number.isNaN(speed) || speed < 1) speed = 1;
  return 1 / speed;
}

function glyphs(str: string): number {
  return Font.split(str.replace(/[\n\v\f]/g, "")).length;
}

/** TextBox.lua:34 -- PAUSE marks out, with the glyph count at each. */
function stripPauses(text: string): [string, number[] | null] {
  if (!text.includes(TextBox.PAUSE)) return [text, null];
  const parts = text.split(TextBox.PAUSE);
  const marks: number[] = [];
  let count = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    count += glyphs(parts[i]!);
    marks.push(count);
  }
  return [parts.join(""), marks];
}

/** TextBox.lua:72 -- mark index -> page/line/char (all 1-based keys). */
function mapPauses(pages: Pages, marks: number[]): Record<number, Record<number, Record<number, number>>> {
  const at: Record<number, Record<number, Record<number, number>>> = {};
  let acc = 0;
  let mi = 0;
  pages.forEach((page, p) => {
    page.forEach((line, l) => {
      const n = Font.split(line).length;
      while (mi < marks.length && marks[mi]! <= acc + n) {
        const ci = marks[mi]! - acc;
        ((at[p + 1] ??= {})[l + 1] ??= {})[ci] = mi + 1;
        mi++;
      }
      acc += n;
    });
  });
  return at;
}

export class TextBox {
  static isTextBox = true;
  static PAUSE = "\u0001";
  isTextBox = true;

  game: any;
  onDone?: () => void;
  choice?: (yes: boolean) => void;
  defaultNo?: boolean;
  choiceNoSound?: boolean;
  choiceLabels?: [string, string];
  choiceBox?: TextBoxOpts["choiceBox"];
  money?: () => number;
  moneyWithChoice?: boolean;
  auto?: AutoOpts;
  stay?: TextBoxOpts["stay"];
  preSound?: TextBoxOpts["preSound"];
  sfxWait?: boolean;
  waitButton?: boolean;
  instant?: boolean;
  boxTx: number;
  boxTy: number;
  boxTw: number;
  boxTh: number;
  maxCols: number;
  textX: number;
  line1Y: number;
  line2Y: number;
  pages: Pages;
  pauseSounds?: TextBoxOpts["pauseSounds"];
  pauseSoundWait?: boolean;
  pauseAt: Record<number, Record<number, Record<number, number>>> | null;
  pageIndex = 1;
  lineIndex = 1;
  charIndex = 0;
  shown: number[][] = [];
  codes: number[] = [];
  waiting = false;
  contAdvance = false;
  done = false;
  blink = 0;
  scrollPx?: number;
  holdFrames?: number;
  preWait?: number;
  charTimer?: number;
  pauseFrames?: number;
  pauseMark?: number;
  pauseSrc?: SoundSrc | null;
  pauseSrcLeft?: number;
  preStarted?: boolean;
  preSrc?: SoundSrc | null;
  preSrcLeft?: number;
  stayShown?: boolean;
  autoPrompted?: boolean;
  autoStarted?: boolean;
  autoSrc?: SoundSrc | null;
  autoSrcLeft?: number;
  autoTimer = 0;
  afterSoundFired?: boolean;
  overlapFired?: boolean;
  choicePushed?: boolean;

  /** TextBox.lua:95 */
  constructor(game: any, text: string, onDone?: () => void, opts: TextBoxOpts = {}) {
    this.game = game;
    this.onDone = onDone;
    this.choice = opts.choice;
    this.defaultNo = opts.defaultNo;
    this.choiceNoSound = opts.noSound;
    this.choiceLabels = opts.choiceLabels;
    this.choiceBox = opts.choiceBox;
    this.money = opts.money;
    this.moneyWithChoice = opts.moneyWithChoice;
    this.auto = opts.auto === true ? { wait: false } : opts.auto;
    this.stay = opts.stay;
    this.preSound = opts.preSound;
    this.sfxWait = opts.sfxWait;
    this.waitButton = opts.waitButton;
    const ending = TextBox.ending(text);
    if (ending === "prompt") this.waitButton = false;
    else if (ending === "done" && this.waitButton === undefined) this.waitButton = true;
    this.instant = opts.instant;
    const box = Theme.textBox;
    this.boxTx = box.tx ?? BOX_TX;
    this.boxTy = box.ty ?? BOX_TY;
    this.boxTw = box.tw ?? BOX_TW;
    this.boxTh = box.th ?? BOX_TH;
    this.maxCols = box.maxCols ?? MAX_COLS;
    this.textX = (this.boxTx + 1) * 8;
    this.line1Y = (this.boxTy + 2) * 8;
    this.line2Y = (this.boxTy + 4) * 8;
    let marks: number[] | null;
    [text, marks] = stripPauses(TextBox.substitute(game, text));
    this.pages = TextBox.paginate(text, this.maxCols);
    this.pauseSounds = opts.pauseSounds;
    this.pauseSoundWait = opts.pauseSoundWait;
    this.pauseAt = marks ? mapPauses(this.pages, marks) : null;
    if (this.instant) {
      this.pageIndex = this.pages.length;
      const page = this.pages[this.pageIndex - 1] ?? [];
      for (let index = Math.max(1, page.length - 1); index <= page.length; index++) {
        this.shown.push(Font.encode(page[index - 1]!));
      }
      this.lineIndex = page.length;
      this.codes = this.shown[this.shown.length - 1] ?? [];
      this.charIndex = this.codes.length;
      this.done = true;
      return;
    }
    this.beginLine();
  }

  static new(game: any, text: string, onDone?: () => void, opts?: TextBoxOpts): TextBox {
    return new TextBox(game, text, onDone, opts);
  }

  /** TextBox.lua:52 -- "prompt" | "done" | null from the text's trailing tag. */
  static ending(text: unknown): "prompt" | "done" | null {
    if (typeof text !== "string") return null;
    if (/\{PROMPT\}\s*$/.test(text)) return "prompt";
    if (/\{DONE\}\s*$/.test(text)) return "done";
    return null;
  }

  static strip<T>(text: T): T {
    if (typeof text !== "string") return text;
    const t = text.replace(/\{DONE\}\s*$/, "").replace(/\{PROMPT\}\s*$/, "");
    return t.replace(/\{DONE\}/g, "").replace(/\{PROMPT\}/g, "") as T;
  }

  /** TextBox.lua:180 */
  static soundOpts(game: any, sound: string | (() => SoundSrc | null | undefined), opts: TextBoxOpts = {}): TextBoxOpts {
    let auto: AutoOpts = opts.auto === true ? { wait: false } : (opts.auto ?? {});
    if (auto.wait === undefined) auto.wait = true;
    auto.delay = auto.delay ?? 0;
    auto.sound = typeof sound === "function" ? sound : () => snd.play(game.data, sound);
    opts.auto = auto;
    return opts;
  }

  /** TextBox.lua:193 */
  static TOKENS: Record<string, TokenHandler> = {
    PLAYER: (game) => game.save.player.name ?? "RED",
    RIVAL: (game) => {
      const gold = game.save.generation === 2 || game.save.version === "gold";
      return game.save.player.rival ?? game.save.rival?.name ?? (gold ? "???" : "BLUE");
    },
    STRBUF: (game) => game.stringBuffer,
    RAM: (game, arg) => {
      if (arg === "wStringBuffer") return game.stringBuffer;
      if (arg === "wNameBuffer") return game.stringBuffer;
      if (arg === "wBoxNumString") return game.boxNumString;
      if (arg === "wBoxMonNicks") return game.boxMonNicks;
      return null;
    },
    DONE: () => null,
    PROMPT: () => null,
  };

  static registerInto(registry: { register(id: string, h: TokenHandler, owner: unknown): void }, _: unknown, owner: unknown): void {
    for (const [id, handler] of Object.entries(TextBox.TOKENS)) registry.register(id, handler, owner);
  }

  static substitute(game: any, text: string): string {
    const handlers = game?.data?.tokens ?? TextBox.TOKENS;
    return Tokens.expand(game, text, handlers);
  }

  /**
   * TextBox.lua:231 -- pages of lines. "\f" breaks a page, "\n" a line,
   * "\v" a line the player must press on; long lines wrap at a space.
   */
  static paginate(text: string, maxCols?: number): Pages {
    const cols = maxCols ?? Theme.textBox.maxCols ?? MAX_COLS;
    text = TextBox.strip(text);
    const budget = cols * 8;
    const pages: Pages = [];
    const contBefore: boolean[][] = [];
    const pushLine = (lines: string[], conts: boolean[], line: string, wait: boolean): void => {
      for (;;) {
        const spans = Font.split(line);
        let fit = Font.spansFitting(spans, budget);
        if (fit >= spans.length) break;
        fit = Math.max(fit, 1);
        let cut = spans[fit - 1]!.to;
        for (let i = fit; i >= 1; i--) {
          if (line.slice(spans[i - 1]!.from - 1, spans[i - 1]!.to) === " ") {
            cut = spans[i - 1]!.to;
            break;
          }
        }
        lines.push(line.slice(0, cut));
        conts.push(wait);
        wait = false;
        line = line.slice(cut);
      }
      lines.push(line);
      conts.push(wait);
    };
    for (const pageText of text.split("\f")) {
      if (pageText === "") continue;
      const lines: string[] = [];
      const conts: boolean[] = [];
      let pos = 0;
      let waitNext = false;
      for (;;) {
        const m = /[\n\v]/.exec(pageText.slice(pos));
        if (!m) {
          pushLine(lines, conts, pageText.slice(pos), waitNext);
          break;
        }
        const npos = pos + m.index;
        pushLine(lines, conts, pageText.slice(pos, npos), waitNext);
        waitNext = pageText[npos] === "\v";
        pos = npos + 1;
      }
      if (lines[lines.length - 1] === "") {
        lines.pop();
        conts.pop();
      }
      if (lines.length > 0) {
        pages.push(lines);
        contBefore.push(conts);
      }
    }
    if (pages.length === 0) {
      pages.push([""]);
      contBefore.push([false]);
    }
    pages.contBefore = contBefore;
    return pages;
  }

  currentLine(): string {
    return this.pages[this.pageIndex - 1]![this.lineIndex - 1]!;
  }

  beginLine(): void {
    this.charIndex = 0;
    this.codes = Font.encode(this.currentLine());
    if (this.shown.length >= 2) {
      this.shown.shift();
      this.scrollPx = 8; // ScrollTextUpOneLine
    }
    this.shown.push([]);
  }

  visibleText(): string[] | null {
    const page = this.pages[this.pageIndex - 1];
    if (!page) return null;
    const out: string[] = [];
    const count = this.shown.length;
    for (let i = Math.max(1, this.lineIndex - count + 1); i <= this.lineIndex; i++) {
      if (page[i - 1] !== undefined) out.push(page[i - 1]!);
    }
    return out.length > 0 ? out : null;
  }

  sfxHeld(): boolean {
    if (!this.sfxWait) return false;
    if (snd.sfxBusy?.()) return true;
    this.sfxWait = undefined;
    return false;
  }

  isGold(): boolean {
    const save = this.game?.save;
    return !!(save && (save.generation === 2 || save.version === "gold"));
  }

  arrowVisible(): boolean {
    if (this.sfxWait) return false;
    if (this.waiting) return true;
    if (this.waitButton && this.isGold()) return false;
    return !!(
      this.done &&
      !this.choice &&
      (!this.auto || (this.auto.promptFirst && !this.autoPrompted)) &&
      (!this.stay || (this.stay.prompt && !this.stayShown))
    );
  }

  arrowPos(): [number, number] {
    const gold = this.isGold();
    return [(this.boxTx + this.boxTw - 2) * 8, gold ? (this.boxTy + this.boxTh - 1) * 8 : this.line2Y];
  }

  moneyVisible(): boolean {
    if (!this.money) return false;
    return !this.moneyWithChoice || !!this.choicePushed;
  }

  /** TextBox.lua:431 */
  update(_dt?: number): void {
    const input = this.game.input;
    this.blink = (this.blink + 1) % 480;
    if (this.preSound) {
      if (!this.preStarted) {
        this.preStarted = true;
        this.preSrc = this.preSound();
        this.preSrcLeft = sfxWaitFrames(this.preSrc);
      }
      this.preSrcLeft = (this.preSrcLeft ?? 0) - sfxWaitStep(this.game);
      const playing = this.preSrc?.isPlaying?.();
      if (playing && this.preSrcLeft > 0) return;
      if (playing) this.preSrc?.stop?.();
      this.preSound = undefined;
      this.preSrc = undefined;
      this.preSrcLeft = undefined;
    }
    if ((this.holdFrames ?? 0) > 0) {
      this.holdFrames! -= 1;
      return;
    }
    if (this.pauseFrames !== undefined) {
      if (this.pauseFrames > 0) {
        this.pauseFrames -= 1;
        return;
      }
      this.pauseFrames = undefined;
      const s = this.pauseSounds?.[this.pauseMark ?? 0];
      let src: SoundSrc | null | undefined;
      if (typeof s === "function") src = s();
      else if (s) src = snd.play(this.game.data, s);
      if (src && this.pauseSoundWait) {
        this.pauseSrc = src;
        this.pauseSrcLeft = sfxWaitFrames(src);
      }
    }
    if (this.pauseSrc) {
      this.pauseSrcLeft = (this.pauseSrcLeft ?? 0) - sfxWaitStep(this.game);
      const playing = this.pauseSrc.isPlaying?.();
      if (playing && this.pauseSrcLeft > 0) return;
      if (playing) this.pauseSrc.stop?.();
      this.pauseSrc = undefined;
      this.pauseSrcLeft = undefined;
    }
    if (this.done) {
      if (this.stay) {
        if (!this.stayShown) {
          if (this.stay.prompt && !(input.wasPressed("a") || input.wasPressed("b"))) return;
          if (this.stay.prompt) snd.play(this.game.data, "Press_AB");
          this.stayShown = true;
          this.stay.onShown?.();
        }
        return;
      }
      if (this.auto) {
        if (this.auto.promptFirst && !this.autoPrompted) {
          if (!(input.wasPressed("a") || input.wasPressed("b"))) return;
          snd.play(this.game.data, "Press_AB");
          this.autoPrompted = true;
          return;
        }
        if (!this.autoStarted) {
          this.autoStarted = true;
          this.autoSrc = this.auto.sound ? this.auto.sound() : null;
          this.autoSrcLeft = sfxWaitFrames(this.autoSrc);
          this.autoTimer = 0;
        }
        this.auto.tick?.();
        if (this.autoSrc) {
          this.autoSrcLeft = (this.autoSrcLeft ?? 0) - sfxWaitStep(this.game);
          if (this.autoSrc.isPlaying?.()) {
            if (this.autoSrcLeft > 0) return;
            this.autoSrc.stop?.();
          }
        }
        if (this.auto.afterSound && !this.afterSoundFired) {
          this.afterSoundFired = true;
          this.auto.afterSound();
        }
        if (this.auto.wait) {
          this.auto = undefined;
          return;
        }
        this.autoTimer += 1;
        const delay = this.auto.delay ?? 3;
        if (this.auto.onOverlap && !this.overlapFired && this.autoTimer >= delay) {
          this.overlapFired = true;
          this.auto.onOverlap();
        }
        if (this.autoTimer >= delay + (this.auto.overlap ?? 0)) {
          this.game.stack.pop();
          this.onDone?.();
        }
        return;
      }
      if (this.choice) {
        if (!this.choicePushed) {
          this.choicePushed = true;
          const choice = this.choice;
          this.game.stack.push(
            ChoiceBox.new(
              this.game,
              (yes) => {
                this.game.stack.pop(); // this text box, under the choice
                choice(yes);
              },
              {
                defaultNo: this.defaultNo,
                noSound: this.choiceNoSound,
                labels: this.choiceLabels,
                box: this.choiceBox,
                anchor: "bottom",
              },
            ),
          );
        }
        return;
      }
      if (this.sfxHeld()) return;
      if (input.wasPressed("a") || input.wasPressed("b")) {
        if (!this.waitButton) snd.playPress?.(this.game.data);
        this.game.stack.pop();
        this.onDone?.();
      }
      return;
    }
    if (this.waiting) {
      if ((this.preWait ?? 0) > 0) {
        this.preWait! -= 1;
        return;
      }
      if (this.sfxHeld()) return;
      if (input.wasPressed("a") || input.wasPressed("b")) {
        snd.play(this.game.data, "Press_AB");
        this.waiting = false;
        if (this.contAdvance) {
          this.contAdvance = false;
          this.lineIndex += 1;
          this.beginLine();
          this.holdFrames = Timing.TEXT_SCROLL_PAIR;
        } else {
          this.shown = [];
          this.pageIndex += 1;
          this.lineIndex = 1;
          this.beginLine();
          this.holdFrames = Timing.TEXT_PAGE_CLEAR;
        }
      }
      return;
    }
    const rawSpeed = this.game.save?.options?.textSpeed;
    let delay: number = NAME_DELAYS[rawSpeed] ?? rawSpeed ?? 3;
    if (delay !== 1 && delay !== 3 && delay !== 5) delay = 3;
    if (input.isDown("a") || input.isDown("b")) delay = 1;
    this.charTimer = (this.charTimer ?? 0) + 1;
    while (this.charTimer >= delay) {
      this.charTimer -= delay;
      if (this.charIndex < this.codes.length) {
        this.charIndex += 1;
        this.shown[this.shown.length - 1]!.push(this.codes[this.charIndex - 1]!);
        const marks = this.pauseAt?.[this.pageIndex]?.[this.lineIndex];
        if (marks && marks[this.charIndex]) {
          this.pauseMark = marks[this.charIndex];
          this.pauseFrames = this.pauseSoundWait || input.isDown("a") || input.isDown("b") ? 0 : PAUSE_FRAMES;
          break;
        }
      } else {
        const page = this.pages[this.pageIndex - 1]!;
        if (this.lineIndex < page.length) {
          const nextIdx = this.lineIndex + 1;
          const conts = this.pages.contBefore?.[this.pageIndex - 1];
          if (conts && conts[nextIdx - 1]) {
            this.waiting = true;
            this.preWait = Timing.TEXT_PRE_ADVANCE;
            this.contAdvance = true;
          } else {
            this.lineIndex = nextIdx;
            this.beginLine();
          }
        } else if (this.pageIndex < this.pages.length) {
          this.waiting = true;
          this.preWait = Timing.TEXT_PRE_ADVANCE;
          this.contAdvance = false;
        } else {
          this.done = true;
        }
        break;
      }
    }
  }

  /** TextBox.lua:694 */
  draw(): void {
    if (!UIVisibility.bottomVisible(this, true)) return;
    const paper: number[] | undefined = this.game?.textboxPaper?.();
    const gold = this.isGold();
    let drawGlyph: (code: number, x: number, y: number) => void = Font.drawCode;
    let finishGlyph: (() => void) | null = null;
    let arrowOn = this.blink % 60 < 30;
    if (gold) arrowOn = this.blink % 32 < 16;
    const [arrowX, arrowY] = this.arrowPos();
    if (gold) {
      const base = paper ? [paper, paper, paper, [0, 0, 0]] : Chrome.DEFAULT_BOX_PALETTE;
      Chrome.paletteBox(this.boxTx, this.boxTy, this.boxTw, this.boxTh, base);
      if (arrowOn && this.arrowVisible()) Chrome.paletteFill(arrowX, arrowY, 8, 8, base);
      const [, dg, fg] = Chrome.paletteGlyphs(base);
      drawGlyph = dg;
      finishGlyph = fg;
    } else {
      Font.drawBox(this.boxTx, this.boxTy, this.boxTw, this.boxTh, paper);
      G.setColor(0, 0, 0, 1);
    }
    if (this.scrollPx && this.scrollPx > 0) {
      this.scrollPx -= 2;
      if (this.scrollPx <= 0) this.scrollPx = undefined;
    }
    const off = this.scrollPx ?? 0;
    const ys = [this.line1Y, this.line2Y];
    this.shown.forEach((line, i) => {
      const y = (ys[i] ?? this.line2Y) + (i === 0 ? off : 0);
      let pen = this.textX;
      for (const code of line) {
        drawGlyph(code, pen, y);
        pen += Font.advanceOf(code);
      }
    });
    if (this.moneyVisible()) {
      if (gold) {
        Chrome.paletteBox(11, 0, 9, 3, Chrome.DEFAULT_BOX_PALETTE);
      } else {
        Font.drawBox(11, 0, 9, 3);
        G.setColor(1, 1, 1, 1);
        G.rectangle("fill", 13 * 8, 0, 5 * 8, 8);
        G.setColor(0, 0, 0, 1);
        let cap = 13 * 8;
        for (const code of Font.encode("MONEY")) {
          drawGlyph(code, cap, 0);
          cap += Font.advanceOf(code);
        }
      }
      const money = `¥${this.money!() ?? 0}`;
      let pen = 152 - Font.width(money);
      for (const code of Font.encode(money)) {
        drawGlyph(code, pen, 8);
        pen += Font.advanceOf(code);
      }
    }
    if (this.arrowVisible() && arrowOn) drawGlyph(Theme.moreArrow ?? 0xee, arrowX, arrowY);
    finishGlyph?.();
    G.setColor(1, 1, 1, 1);
  }
}

export default TextBox;
