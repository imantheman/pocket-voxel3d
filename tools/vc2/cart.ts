// Driving a real Gen 2 cartridge in the headless GBC (gbc.ts) for the VC
// save tests: frames, presses, waits on the game's own RAM, screenshots, and
// the battery save in and out (with the cartridge clock).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Gbc, png, BTN } from "./gbc.ts";

export { BTN };
export type Engine = "gs" | "crystal";

/** WRAM <-> SRAM: the three blocks SaveGameData copies (main copy). */
export const BLOCKS: Record<Engine, [number, number, number][]> = {
  // [sram offset, wram address, length]
  gs: [[0x2009, 0xd1a1, 0x84d], [0x2856, 0xd9ee, 0x34], [0x288a, 0xda22, 0x4df]],
  crystal: [[0x2009, 0xd47b, 0x82a], [0x2833, 0xdca5, 0x32], [0x2865, 0xdcd7, 0x31e]],
};

export function wramOf(engine: Engine, sram: number): number {
  for (const [s, w, n] of BLOCKS[engine]) if (sram >= s && sram < s + n) return w + sram - s;
  throw new Error(`sram ${sram.toString(16)} is not in a saved block`);
}
export function sramOf(engine: Engine, wram: number): number | undefined {
  for (const [s, w, n] of BLOCKS[engine]) if (wram >= w && wram < w + n) return s + wram - w;
  return undefined;
}

/** The English cartridges' text bytes, enough to read menus and prompts. */
export function charOf(b: number): string {
  if (b >= 0x80 && b <= 0x99) return String.fromCharCode(65 + b - 0x80);
  if (b >= 0xa0 && b <= 0xb9) return String.fromCharCode(97 + b - 0xa0);
  if (b >= 0xf6) return String.fromCharCode(48 + b - 0xf6);
  const t: Record<number, string> = {
    0x7f: " ", 0xed: "▶", 0xec: "▷", 0xee: "▼", 0xe6: "?", 0xe7: "!", 0xe8: ".", 0xe3: "-", 0xf4: ",",
    0x9c: ":", 0x9a: "(", 0x9b: ")", 0xe0: "'", 0x79: "+", 0x7a: "-", 0x7b: "+", 0x7c: "|", 0x7d: "+", 0x7e: "+",
    0x50: "@", 0xe1: "P", 0xe2: "M", 0xef: "m", 0xf5: "f", 0xf3: "/", 0xe9: "&", 0xea: "e", 0x54: "#", 0x75: "…",
  };
  return t[b] ?? (b === 0 ? " " : "~");
}

export class Cart {
  gb: Gbc;
  engine: Engine;
  shotDir?: string;
  log: string[] = [];

  constructor(public game: "gold" | "silver" | "crystal", romPath: string, sram?: Uint8Array) {
    this.gb = new Gbc(new Uint8Array(readFileSync(romPath)), sram);
    this.engine = game === "crystal" ? "crystal" : "gs";
    this.gb.render = true;
  }

  /** A RAM byte by its save offset (the main copy's offset). */
  ram(sramOff: number): number {
    return this.gb.wram(wramOf(this.engine, sramOff), 1);
  }
  ramW(wram: number): number {
    return this.gb.wram(wram, 1);
  }

  /** The 20x18 text the game has drawn (its wTilemap buffer), one string a row. */
  text(): string[] {
    const base = this.engine === "crystal" ? 0xc4a0 : 0xc3a0;
    const rows: string[] = [];
    for (let y = 0; y < 18; y++) {
      let s = "";
      for (let x = 0; x < 20; x++) s += charOf(this.gb.wram(base + y * 20 + x));
      rows.push(s);
    }
    return rows;
  }
  /** Whether the drawn text holds `s` anywhere. */
  shows(s: string): boolean {
    return this.text().some((r) => r.includes(s));
  }
  /** Move a menu's ▶ to the row holding `label` (UP/DOWN), then press A. */
  pick(label: string, max = 12): boolean {
    for (let k = 0; k < max; k++) {
      const rows = this.text();
      const want = rows.findIndex((r) => r.includes(label));
      const at = rows.findIndex((r) => {
        const i = r.indexOf(label === "" ? "▶" : "▶");
        return i >= 0;
      });
      if (want < 0) { this.run(10); continue; }
      const cursorRows = rows.map((r, i) => (r.includes("▶") ? i : -1)).filter((i) => i >= 0);
      const cur = cursorRows.length ? cursorRows.reduce((best, i) => (Math.abs(i - want) < Math.abs(best - want) ? i : best)) : at;
      if (cur === want) { this.press(BTN.A, 4, 16); return true; }
      this.press(cur < want ? BTN.DOWN : BTN.UP, 4, 10);
    }
    return false;
  }

  /** Wait (pressing nothing) until the text shows `s`. */
  waitText(s: string, max = 1200): boolean {
    return this.waitUntil(() => this.shows(s), max);
  }
  /** START -> SAVE -> YES (-> YES over an older file), as a player saves.
   *  True once the game has said it saved. */
  saveGame(): boolean {
    if (!this.mashUntil(BTN.START, () => this.shows("SAVE"), 400, 40)) return false;
    this.run(20);
    if (!this.pick("SAVE")) return false;
    if (!this.waitText("YES", 600)) return false;
    this.run(10);
    this.pick("YES");
    for (let f = 0; f < 1500; f++) {
      if (this.shows("save file")) {
        // "There is already a save file. Is it OK to overwrite?" (or another
        // player's): read on to the YES/NO, then YES
        this.mashUntil(BTN.A, () => this.shows("YES"), 400, 20);
        this.run(10);
        this.pick("YES");
        this.run(20);
      }
      if (this.shows("saved")) break;
      this.frame(0);
    }
    const ok = this.waitText("saved", 600);
    this.run(120);
    // close what is left open
    for (let k = 0; k < 4 && (this.shows("SAVE") || this.shows("saved")); k++) this.press(BTN.B, 4, 30);
    return ok;
  }

  run(n: number, buttons = 0): void {
    for (let i = 0; i < n; i++) this.frame(buttons);
  }
  /** One frame; throws once the game has stopped answering. */
  frame(buttons = 0): void {
    this.gb.frame(buttons);
    if (this.gb.stuck) throw new Error(`cartridge ${this.gb.stuck}`);
  }
  press(b: number, hold = 4, gap = 12): void {
    this.run(hold, b);
    this.run(gap, 0);
  }
  /** Press `b` every `every` frames until `done()` or `max` frames. */
  mashUntil(b: number, done: () => boolean, max = 3000, every = 16): boolean {
    for (let f = 0; f < max; f++) {
      if (done()) return true;
      this.frame(f % every < 3 ? b : 0);
    }
    return done();
  }
  waitUntil(done: () => boolean, max = 3000): boolean {
    for (let f = 0; f < max; f++) {
      if (done()) return true;
      this.frame(0);
    }
    return done();
  }
  shot(name: string): void {
    if (!this.shotDir) return;
    mkdirSync(this.shotDir, { recursive: true });
    writeFileSync(`${this.shotDir}/${name}.png`, png(this.gb.screen(), 160, 144));
  }
  private snaps: Uint8Array[] = [];
  /** Keep this frame for a contact sheet. */
  snap(): void {
    this.snaps.push(this.gb.screen().slice());
  }
  /** The kept frames as one PNG, `cols` across (then forgotten). */
  sheet(path: string, cols = 6): void {
    const n = this.snaps.length;
    if (!n) return;
    const rows = Math.ceil(n / cols);
    const W = cols * 162, H = rows * 146;
    const out = new Uint8Array(W * H * 4).fill(255);
    this.snaps.forEach((s, k) => {
      const ox = (k % cols) * 162, oy = Math.floor(k / cols) * 146;
      for (let y = 0; y < 144; y++) out.set(s.subarray(y * 640, y * 640 + 640), ((oy + y) * W + ox) * 4);
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, png(out, W, H));
    this.snaps = [];
  }
  /** The battery save as mGBA/VC would hold it (32 KB). */
  sram(): Uint8Array {
    return this.gb.sram.slice();
  }
  saveTo(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, this.gb.sram);
  }
}
