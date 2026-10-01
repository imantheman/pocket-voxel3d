// SAVE from the start menu: a port of gen1recomp src/ui/gen2/SaveMenu.lua
// (bdfac727, MIT) -- engine/menus/save.asm SaveMenu.
//
// SaveMenu is four calls:
//   DisplayNormalContinueData with `lb de, 4, 0`: CONTINUE's panel moved to a
//     16x10 box over (4,0)..(19,9), labels at (5,2), (5,4), (5,6), (5,8).
//   SpeechTextbox, the ordinary 18x4 box over rows 12-17.
//   SaveTheGame_yesorno: a 6x5 yes/no box at (0,7), YES at (2,8), NO at (2,10).
//   SavingDontTurnOffThePower, a timed sequence: "SAVING… DON'T TURN / OFF
//     THE POWER." for 16 frames, the write, 32 more (SavedTheGame,
//     engine/menus/save.asm:242-262).
// Overwriting an existing file gets a second yes/no first (AskOverwriteSaveFile).
//
// The write goes through `writer` -- Game2 hands in Game2:writeSave, which
// lands in platform/saveio's store.

import { Chrome } from "./Chrome.ts";
import { Save } from "../core/Save.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Typer } from "./Typer.ts";
import G from "../platform/screen.ts";

type Page = string[] & { scrolled?: boolean };
type Phase = "confirm" | "overwrite" | "saving" | "done";

export interface SaveMenuOpts {
  save?: any;
  onDone?: (saved: boolean) => void;
  existed?: boolean;
  writer?: (save: any) => unknown;
}

// Lua: SaveMenu.lua:43 -- SFX_SAVE ($25, constants/sfx_constants.asm:40),
// an index into the sfx pointer table.
const SFX_SAVE = 0x25;

// Lua: SaveMenu.lua:47 -- SavingDontTurnOffThePower's DelayFrames counts.
// ../pokecrystal/engine/menus/save.asm:242 SavedTheGame
const SAVING_FRAMES = 16;
const SAVED_GAP_FRAMES = 32;
const SAVED_TAIL_FRAMES = 30;
const SAVED_FRAMES = SAVED_GAP_FRAMES + SAVED_TAIL_FRAMES;

// Lua: SaveMenu.lua:53 -- MenuBox coordinates after _OffsetMenuHeader(4, 0).
const PANEL_X = 4;
const PANEL_Y = 0;
const PANEL_W = 16;
const PANEL_H = 10;
const LABEL_X = 5;
const LABEL_Y = 2;
// Continue_DisplayBadgesDex / Continue_PrintGameTime: (4,0) + (13,4) / (12,6) / (9,8).
const BADGES_X = 17;
const BADGES_Y = 4;
const DEX_X = 16;
const DEX_Y = 6;
const TIME_X = 13;
const TIME_Y = 8;

const YESNO_X = 0;
const YESNO_Y = 7;
const YESNO_W = 6;
const YESNO_H = 5;

// Lua: SaveMenu.lua:80 -- ../pokecrystal/data/text/common_3.asm:202 _AlreadyASaveFileText
const OVERWRITE_PROMPT_SOURCE = Strings.source("There is already a\nsave file. Is it\vOK to overwrite?");
const SAVING_PROMPT_SOURCE = Strings.source("SAVING… DON'T TURN\nOFF THE POWER.");

// Lua: SaveMenu.lua:84 -- ../pokecrystal/home/text.asm:630 LoadBlinkingCursor
const DOWN_ARROW = "▼";
const ARROW_X = 18;
const ARROW_Y = 17;

// Lua: SaveMenu.lua:89 -- ../pokecrystal/home/text.asm:479 Paragraph,
// :520 _ContTextNoPause. \f splits pages; \v scrolls (keeps the last line).
function pagesOf(body: unknown): Page[] {
  const pages: Page[] = [];
  const chunks = (String(body) + "\f").split("\f");
  chunks.pop();
  for (const chunk of chunks) {
    const flat: [string, boolean][] = [];
    let pos = 0;
    let scrolled = false;
    for (;;) {
      const m = /[\n\v]/.exec(chunk.slice(pos));
      const brk = m ? pos + m.index : -1;
      const line = brk >= 0 ? chunk.slice(pos, brk) : chunk.slice(pos);
      if (line !== "") flat.push([line, scrolled]);
      if (brk < 0) break;
      scrolled = chunk[brk] === "\v";
      pos = brk + 1;
    }
    let page: Page | undefined;
    for (const entry of flat) {
      if (!page) {
        page = [entry[0]];
        pages.push(page);
      } else if (entry[1]) {
        const next: Page = [page[page.length - 1]!, entry[0]];
        next.scrolled = true;
        page = next;
        pages.push(page);
      } else if (page.length >= 2) {
        page = [entry[0]];
        pages.push(page);
      } else {
        page.push(entry[0]);
      }
    }
  }
  if (pages.length === 0) pages[0] = [""];
  return pages;
}

export class SaveMenu {
  [key: string]: any;
  // Lua: SaveMenu.lua:35 -- ../pokecrystal/engine/menus/save.asm:1
  static isOpaque = false;
  // Lua: SaveMenu.lua:344 -- ../pokecrystal/engine/menus/intro_menu.asm:479
  static PANEL = {
    x: PANEL_X, y: PANEL_Y, w: PANEL_W, h: PANEL_H,
    labelX: LABEL_X, labelDy: LABEL_Y,
    badgesX: BADGES_X, badgesDy: BADGES_Y,
    dexX: DEX_X, dexDy: DEX_Y,
    timeX: TIME_X, timeDy: TIME_Y,
  };
  static SFX_SAVE = SFX_SAVE;
  static SAVING_FRAMES = SAVING_FRAMES;
  static SAVED_GAP_FRAMES = SAVED_GAP_FRAMES;
  static SAVED_TAIL_FRAMES = SAVED_TAIL_FRAMES;
  static SAVED_FRAMES = SAVED_FRAMES;
  static OVERWRITE_PROMPT_SOURCE = OVERWRITE_PROMPT_SOURCE;
  static SAVING_PROMPT_SOURCE = SAVING_PROMPT_SOURCE;
  static pagesOf = pagesOf;
  static DOWN_ARROW = DOWN_ARROW;
  static ARROW_X = ARROW_X;
  static ARROW_Y = ARROW_Y;

  isOpaque = false;
  game: any;
  save: any;
  onDone?: (saved: boolean) => void;
  writer: (save: any) => unknown = (s) => Save.save(s);
  existed = false;
  phase: Phase = "confirm";
  choice = 1;
  timer = 0;
  typedPhase?: Phase;
  pages?: Page[];
  page = 1;
  typer?: Typer;
  saved?: boolean;
  rang?: boolean;

  // Lua: SaveMenu.lua:121
  wantsFillScale(): boolean {
    return true;
  }

  // Lua: SaveMenu.lua:124 -- opts: save, onDone(saved), existed, writer
  static new(game: any, opts?: SaveMenuOpts): SaveMenu {
    const o = opts ?? {};
    const self = new SaveMenu();
    self.game = game;
    self.save = o.save ?? (game ? game.save : undefined);
    self.onDone = o.onDone;
    if (o.writer) self.writer = o.writer;
    let existed = o.existed;
    if (existed == null) existed = Save.exists();
    self.existed = existed;
    // confirm -> overwrite (only when a file exists) -> saving -> done
    self.phase = "confirm";
    self.choice = 1; // 1 YES, 2 NO
    self.timer = 0;
    return self;
  }

  // Lua: SaveMenu.lua:141
  static playSaveSfx(game: any, id: number): void {
    const data = game ? game.data : undefined;
    const audio = data ? data.audio : undefined;
    if (!(audio && audio.sfxOrder)) return;
    const name = audio.sfxOrder[id];
    if (name && audio.sfx && audio.sfx[name]) Sound.play(data, name);
  }

  // Lua: SaveMenu.lua:149
  playSfx(id: number): void {
    SaveMenu.playSaveSfx(this.game, id);
  }

  // Lua: SaveMenu.lua:154 -- ../pokecrystal/home/joypad.asm:392
  playSfxNamed(name: string): void {
    const data = this.game ? this.game.data : undefined;
    const sfx = data && data.audio ? data.audio.sfx : undefined;
    if (sfx && sfx[Sound.resolve(data, name)]) Sound.play(data, name);
  }

  // Lua: SaveMenu.lua:160
  finish(saved: boolean | undefined): void {
    if (this.onDone) this.onDone(saved === true);
  }

  // Lua: SaveMenu.lua:164
  playerName(): string {
    return (this.save && this.save.player && this.save.player.name) || "GOLD";
  }

  // Lua: SaveMenu.lua:170 -- ../pokecrystal/engine/menus/save.asm:244 _SaveGameData
  writeNow(): void {
    const result = this.writer(this.save);
    // the writer answers `ok, err` (a tuple here); only `ok` is read
    const ok = Array.isArray(result) ? result[0] : result;
    this.saved = !!ok;
  }

  // Lua: SaveMenu.lua:176 -- ../pokecrystal/engine/menus/save.asm:346
  enterPhase(phase: Phase): void {
    this.phase = phase;
    this.timer = 0;
    this.typedPhase = phase;
    this.pages = pagesOf(this.promptText());
    this.page = 1;
    const pinned = phase === "saving" || phase === "done" ? "MID" : undefined;
    this.typer = Typer.new(this.game, { speed: pinned });
    this.typer.start(this.pages[0]);
  }

  // Lua: SaveMenu.lua:187
  accept(): void {
    if (this.phase === "confirm") {
      if (this.choice === 2) {
        this.finish(false);
        return;
      }
      if (this.existed) {
        this.choice = 1;
        this.enterPhase("overwrite");
        return;
      }
      this.enterPhase("saving");
      return;
    }
    if (this.phase === "overwrite") {
      if (this.choice === 2) {
        this.finish(false);
        return;
      }
      this.enterPhase("saving");
    }
  }

  // Lua: SaveMenu.lua:210
  update(_dt?: number): void {
    if (this.typedPhase !== this.phase) this.enterPhase(this.phase);
    const typed = Typer.step(this);

    // The saving and saved messages are DelayFrames, not prompts.
    // ../pokecrystal/engine/menus/save.asm:352
    if (this.phase === "saving") {
      if (!typed) return;
      this.timer += 1;
      if (this.timer === SAVING_FRAMES) this.writeNow();
      if (this.timer >= SAVING_FRAMES + SAVED_GAP_FRAMES) this.enterPhase("done");
      return;
    }
    if (this.phase === "done") {
      if (!typed) return;
      // ../pokecrystal/engine/menus/save.asm:259 WaitPlaySFX / home/audio.asm:220
      if (this.saved && !this.rang) {
        this.rang = true;
        Sound.waitSfxDone();
        this.playSfx(SFX_SAVE);
        return;
      }
      // ../pokecrystal/engine/menus/save.asm:260 WaitSFX
      if (Sound.sfxBusy()) return;
      this.timer += 1;
      if (this.timer >= SAVED_TAIL_FRAMES) this.finish(this.saved);
      return;
    }

    const input = this.game ? this.game.input : undefined;
    if (!input) return;
    if (Typer.typing(this)) return;
    const pages = this.pages ?? [];
    // ../pokecrystal/home/text.asm:502 _ContText
    if (this.page < pages.length) {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        this.page += 1;
        this.typer!.start(pages[this.page - 1]);
        this.playSfxNamed("Sfx_ReadText2");
      }
      return;
    }
    if (input.wasPressed("up") || input.wasPressed("down")) {
      this.choice = this.choice === 1 ? 2 : 1;
      return;
    }
    if (input.wasPressed("a")) {
      this.accept();
    } else if (input.wasPressed("b")) {
      // B out of a yes/no is NO (InterpretTwoOptionMenu returns carry).
      this.finish(false);
    }
  }

  // Lua: SaveMenu.lua:269
  promptText(): string {
    if (this.phase === "overwrite") {
      // AlreadyASaveFileText (AnotherSaveFileText cannot happen here).
      return Strings.get(OVERWRITE_PROMPT_SOURCE);
    }
    if (this.phase === "saving") {
      return Strings.get(SAVING_PROMPT_SOURCE);
    }
    if (this.phase === "done") {
      if (this.saved) {
        return Strings.get("%s saved\nthe game.", this.playerName());
      }
      return Strings.get("Could not save.");
    }
    return Strings.get("Would you like to\nsave the game?");
  }

  // Lua: SaveMenu.lua:287
  prompt(): Page {
    if (this.typedPhase === this.phase && this.pages) {
      return this.pages[this.page - 1] ?? this.pages[0]!;
    }
    return pagesOf(this.promptText())[0]!;
  }

  // Lua: SaveMenu.lua:295 -- ../pokecrystal/engine/menus/save.asm:209 SaveTheGame_yesorno
  yesNoVisible(): boolean {
    if (this.phase !== "confirm" && this.phase !== "overwrite") return false;
    if (this.typedPhase !== this.phase || Typer.typing(this)) return false;
    return this.page >= (this.pages ?? []).length;
  }

  // Lua: SaveMenu.lua:301
  drawPanel(): void {
    const summary = Save.summary(this.save);
    Chrome.box(PANEL_X, PANEL_Y, PANEL_W, PANEL_H);
    if (summary) {
      Chrome.print(Strings.get("PLAYER %s", summary.name), LABEL_X, LABEL_Y);
      Chrome.print(Strings.get("BADGES"), LABEL_X, LABEL_Y + 2);
      Chrome.print(Strings.get("POKéDEX"), LABEL_X, LABEL_Y + 4);
      Chrome.print(Strings.get("TIME"), LABEL_X, LABEL_Y + 6);
      // PrintNum fills its field from the left, space padded.
      Chrome.print(Chrome.number(summary.badges, 2), BADGES_X, BADGES_Y);
      Chrome.print(Chrome.number(summary.caught, 3), DEX_X, DEX_Y);
      Chrome.print(Chrome.number(summary.hours, 3), TIME_X, TIME_Y);
      Chrome.print(":", TIME_X + 3, TIME_Y);
      Chrome.print(Chrome.number(summary.minutes, 2, true), TIME_X + 4, TIME_Y);
    }

    // SpeechTextbox: interior 18x4 at (0,12), lines at (1,14) and (1,16).
    Chrome.textbox(0, 12, 18, 4);
    let lines: string[] = this.prompt();
    if (this.typedPhase === this.phase) lines = (Typer.text(this, lines) as string[] | undefined) ?? lines;
    Chrome.print(lines[0] ?? "", 1, 14);
    Chrome.print(lines[1] ?? "", 1, 16);

    if (this.typedPhase === this.phase && !Typer.typing(this) && this.page < (this.pages ?? []).length && Typer.arrowOn(this)) {
      Chrome.print(DOWN_ARROW, ARROW_X, ARROW_Y);
    }

    if (this.yesNoVisible()) {
      Chrome.box(YESNO_X, YESNO_Y, YESNO_W, YESNO_H);
      Chrome.print(Strings.get("YES"), YESNO_X + 2, YESNO_Y + 1);
      Chrome.print(Strings.get("NO"), YESNO_X + 2, YESNO_Y + 3);
      Chrome.cursor(YESNO_X + 1, YESNO_Y + (this.choice === 1 ? 1 : 3));
    }
    G.setColor(1, 1, 1, 1);
  }

  // Lua: SaveMenu.lua:339
  draw(): void {
    this.drawPanel();
  }
}

export default SaveMenu;
