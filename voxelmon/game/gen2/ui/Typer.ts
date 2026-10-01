// gen1recomp src/ui/gen2/Typer.lua (bdfac727): letter-by-letter text for the
// screens that type their own messages.
// ../pokecrystal/home/print_text.asm:1 PrintLetterDelay
// ../pokecrystal/home/text.asm:660 PrintTextboxTextAt

import { Font } from "../shared/render/Font.ts";

/** A page: a string with "\n" line breaks, or a list of lines (`scrolled` keeps line 1). */
export type TyperPage = string | (string[] & { scrolled?: boolean });

export interface TyperOpts {
  speed?: string | number;
  instant?: boolean;
  expand?: (line: string) => string;
}

export interface TyperRecord {
  pages: TyperPage[];
  page: number;
  onDone?: (() => void) | undefined;
  [key: string]: unknown;
}

// Lua: Typer.lua:10 -- ../pokecrystal/home/print_text.asm:5
const DELAYS: Record<string, number> = { FAST: 1, MID: 3, SLOW: 5 };

// Lua: Typer.lua:12 -- Font.split always exists here
function spansOf(text: string): { from: number; to: number }[] {
  return Font.split(text) as { from: number; to: number }[];
}

// Lua: Typer.lua:32
function linesOf(page: TyperPage | null | undefined): string[] {
  if (page == null) return [];
  if (typeof page === "string") return page.split("\n");
  return page;
}

export class Typer {
  static DELAYS = DELAYS;

  game: any;
  speed: string | number | undefined;
  instant: boolean;
  expand: ((line: string) => string) | undefined;
  shown = 0;
  total = 0;
  timer = 0;
  page: string[] = [];

  constructor(game: any, opts: TyperOpts = {}) {
    this.game = game;
    this.speed = opts.speed;
    this.instant = !!opts.instant;
    this.expand = opts.expand;
  }

  /** Lua: Typer.lua:43 -- ../pokecrystal/engine/events/pokecenter_pc.asm:314 */
  static new(game: any, opts?: TyperOpts): Typer {
    return new Typer(game, opts ?? {});
  }

  /** Lua: Typer.lua:58 -- ../pokecrystal/home/text.asm:520 _ContTextNoPause */
  start(page: TyperPage | null | undefined): void {
    const out: string[] = [];
    let total = 0;
    let kept = 0;
    const scrolled = Array.isArray(page) && !!page.scrolled;
    linesOf(page).forEach((line, i) => {
      const text = this.expand ? this.expand(line) : line;
      out[i] = text;
      const n = spansOf(text).length;
      total += n;
      if (scrolled && i === 0) kept = n;
    });
    this.page = out;
    this.total = total;
    this.shown = this.instant ? total : kept;
    this.timer = 0;
  }

  /** Lua: Typer.lua:75 -- ../pokecrystal/home/print_text.asm:52 */
  delay(): number {
    if (this.instant) return 0;
    const options = this.game?.save?.options;
    const raw = this.speed ?? options?.textSpeed;
    let delay = (raw != null ? DELAYS[String(raw)] : undefined) ?? (Number.isFinite(Number(raw)) && raw != null ? Number(raw) : 3);
    if (delay !== 1 && delay !== 3 && delay !== 5) delay = 3;
    const input = this.game?.input;
    if (input && input.isDown && (input.isDown("a") || input.isDown("b"))) delay = 1;
    return delay;
  }

  /** Lua: Typer.lua:89 */
  done(): boolean {
    return this.shown >= this.total;
  }

  /** Lua: Typer.lua:93 */
  tick(): boolean {
    if (this.done()) return true;
    const delay = this.delay();
    if (delay <= 0) {
      this.shown = this.total;
      return true;
    }
    if (this.timer >= delay) this.timer = delay - 1;
    this.timer += 1;
    while (this.timer >= delay && this.shown < this.total) {
      this.timer -= delay;
      this.shown += 1;
    }
    return this.done();
  }

  /** Lua: Typer.lua:109 */
  lines(): string[] {
    if (this.done()) return this.page;
    const out: string[] = [];
    let left = this.shown;
    this.page.forEach((line, i) => {
      const spans = spansOf(line);
      if (left >= spans.length) out[i] = line;
      else if (left <= 0) out[i] = "";
      else out[i] = line.slice(0, spans[left - 1]!.to);
      left -= spans.length;
    });
    return out;
  }

  /** Lua: Typer.lua:127 -- ../pokecrystal/home/menu.asm:328 */
  static say(screen: any, pages: TyperPage[] | null | undefined, onDone?: () => void, opts?: TyperOpts): TyperRecord {
    screen.message = { pages: pages ?? [], page: 1, onDone };
    screen.typer = Typer.new(screen.game, opts);
    screen.typer.start(screen.message.pages[0]);
    return screen.message;
  }

  /** Lua: Typer.lua:134 */
  static begin<T extends { pages?: TyperPage[]; page?: number }>(screen: any, record: T, opts?: TyperOpts): T {
    screen.typer = Typer.new(screen.game, opts);
    screen.typer.start(record.pages ? record.pages[(record.page ?? 1) - 1] : undefined);
    return record;
  }

  /** Lua: Typer.lua:140 */
  static turn(screen: any, record: { pages: TyperPage[]; page: number }): void {
    record.page += 1;
    if (screen.typer) screen.typer.start(record.pages[record.page - 1]);
  }

  /** Lua: Typer.lua:145 */
  static step(screen: any): boolean {
    screen.arrowBlink = ((screen.arrowBlink ?? 0) + 1) % 32;
    const typer: Typer | undefined = screen.typer;
    if (!typer) return true;
    return typer.tick();
  }

  /** Lua: Typer.lua:153 -- ../pokegold/home/joypad.asm:430 */
  static arrowOn(screen: any): boolean {
    return (screen.arrowBlink ?? 0) % 32 < 16;
  }

  /** Lua: Typer.lua:158 -- ../pokecrystal/home/print_text.asm:59 */
  static typing(screen: any): boolean {
    const typer: Typer | undefined = screen.typer;
    return typer != null && !typer.done();
  }

  /** Lua: Typer.lua:163 */
  static text<T>(screen: any, fallback?: T): string[] | T | undefined {
    const typer: Typer | undefined = screen.typer;
    if (!typer) return fallback;
    return typer.lines();
  }
}

export default Typer;
