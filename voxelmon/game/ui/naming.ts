// Gen 1 letter-grid naming screen. Ports gen1recomp src/ui/NamingScreen.lua
// (engine/menus/naming_screen.asm) onto the voxel ui tile layer: five 9-cell
// glyph rows ending in ED, plus a case-switch row.
//
//   A       pick the cell under the cursor
//   B       delete the last glyph
//   SELECT  flip case
//   START   confirm (same as the ED cell)
//
// Rendering is the scene frontend's job (scene.ts reads view()); this file is
// the state machine only, matching how textbox.ts is split.

import type { GameState } from "../game.ts";
import type { Input } from "../input.ts";

const GRID_UPPER: string[][] = [
  ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
  ["J", "K", "L", "M", "N", "O", "P", "Q", "R"],
  ["S", "T", "U", "V", "W", "X", "Y", "Z", " "],
  ["*", "(", ")", ":", ";", "[", "]", "PK", "MN"],
  ["-", "?", "!", "M", "F", "/", ".", ",", "ED"],
  ["lower case"],
];

const GRID_LOWER: string[][] = [
  ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
  ["j", "k", "l", "m", "n", "o", "p", "q", "r"],
  ["s", "t", "u", "v", "w", "x", "y", "z", " "],
  ["*", "(", ")", ":", ";", "[", "]", "PK", "MN"],
  ["-", "?", "!", "M", "F", "/", ".", ",", "ED"],
  ["UPPER CASE"],
];

/** What scene.ts needs to draw the screen. */
export interface NamingView {
  title: string;
  grid: string[][];
  row: number;
  col: number;
  /** Glyphs entered so far, already joined for display. */
  name: string;
  maxLen: number;
}

export interface NamingOpts {
  /** Menu mode: one cell per entry, A commits that entry verbatim. */
  pick?: string[];
  title?: string;
  maxLen?: number;
  default?: string;
  onDone: (name: string) => void;
}

export class NamingState implements GameState {
  readonly kind = "naming";
  private glyphs: string[] = [];
  private row = 0;
  private col = 0;
  private lower = false;
  private readonly title: string;
  private readonly maxLen: number;
  private readonly onDone: (name: string) => void;
  private readonly pick?: string[];

  constructor(private game: { input: Input; pop(): void }, opts: NamingOpts) {
    this.title = opts.title ?? "YOUR NAME?";
    this.maxLen = opts.maxLen ?? 7;
    this.onDone = opts.onDone;
    this.pick = opts.pick;
    if (opts.default) this.glyphs = [...opts.default].slice(0, this.maxLen);
  }

  private grid(): string[][] {
    if (this.pick) return this.pick.map((p) => [p]);
    return this.lower ? GRID_LOWER : GRID_UPPER;
  }

  /** Cursor row/col clamped to the (possibly short) row it landed on. */
  private clamp(): void {
    const g = this.grid();
    if (this.row < 0) this.row = g.length - 1;
    if (this.row >= g.length) this.row = 0;
    const w = g[this.row]!.length;
    if (this.col >= w) this.col = w - 1;
    if (this.col < 0) this.col = 0;
  }

  private confirm(): void {
    const name = this.glyphs.join("");
    this.game.pop();
    this.onDone(name.length > 0 ? name : "RED");
  }

  private commit(cell: string): void {
    if (this.pick) {
      this.game.pop();
      this.onDone(cell);
      return;
    }
    if (cell === "ED") {
      this.confirm();
      return;
    }
    if (cell === "lower case" || cell === "UPPER CASE") {
      this.lower = !this.lower;
      this.row = 0;
      this.col = 0;
      return;
    }
    if (this.glyphs.length < this.maxLen) this.glyphs.push(cell);
  }

  update(): void {
    const inp = this.game.input;
    const p = inp.pressed;

    if (p.up) this.row -= 1;
    if (p.down) this.row += 1;
    if (p.left) this.col -= 1;
    if (p.right) this.col += 1;
    if (p.up || p.down || p.left || p.right) this.clamp();

    if (p.select) {
      this.lower = !this.lower;
      this.row = 0;
      this.col = 0;
    }
    if (p.b) this.glyphs.pop();
    if (p.start) this.confirm();
    if (p.a) {
      const cell = this.grid()[this.row]?.[this.col];
      if (cell !== undefined) this.commit(cell);
    }
  }

  view(): NamingView {
    return {
      title: this.title,
      grid: this.grid(),
      row: this.row,
      col: this.col,
      name: this.glyphs.join(""),
      maxLen: this.maxLen,
    };
  }
}
