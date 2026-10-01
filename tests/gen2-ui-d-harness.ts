// Shared harness for the group D screen tests (shops, PCs, services and
// minigames): a real Game2 with the Gold data loaded, an Lcd to draw into,
// frame stepping through Input + the StateStack, and PNG shots.

import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { resetDrawState, setLcd } from "../voxelmon/game/gen2/platform/screen.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Input } from "../voxelmon/game/gen2/shared/core/Input.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";

export const gold = haveGoldGen();
export { VOX_BTN, Input, Mon };

let tilesReady = false;

export interface Rig {
  game: any;
  lcd: Lcd;
  /** One frame: set the pad, step Input, update the top state. */
  frame(buttons?: number): void;
  /** Press a button for one frame, then release for `gap` frames. */
  press(name: keyof typeof VOX_BTN, gap?: number): void;
  /** Run `n` idle frames. */
  idle(n: number): void;
  /** Draw the whole stack the way Game2.draw does, into the Lcd. */
  draw(): void;
  /** Draw and write a PNG to $GOLD_SHOTS/<name>.png when it is set. */
  shot(name: string): Promise<void>;
}

/**
 * A real Game2 with the Gold data loaded. `load()` ends by pushing the
 * copyright splash, which may still be a stub; the data is in by then, so a
 * throw from it is swallowed and the stack is cleared.
 */
export async function rig(opts: { seed?: number } = {}): Promise<Rig> {
  useGoldGen();
  if (!tilesReady) {
    const { useGoldTiles } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
    useGoldTiles();
    tilesReady = true;
  }
  seed(opts.seed ?? 1234);
  const game: any = Game2.new();
  try {
    game.load({ startWorld: false });
  } catch {
    // the copyright splash is not ours
  }
  game.stack.clear();
  const lcd = new Lcd(new RecorderHost());
  setLcd(lcd);
  const frame = (buttons = 0) => {
    Input.setButtons(buttons);
    Input.step();
    game.stack.update(1 / 60);
  };
  const r: Rig = {
    game,
    lcd,
    frame,
    press(name, gap = 1) {
      frame(VOX_BTN[name]);
      for (let i = 0; i < gap; i++) frame(0);
    },
    idle(n) {
      for (let i = 0; i < n; i++) frame(0);
    },
    draw() {
      setLcd(lcd);
      lcd.begin();
      resetDrawState();
      game.stack.draw();
    },
    async shot(name) {
      r.draw();
      if (!process.env.GOLD_SHOTS) return;
      const { shotLcd } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
      shotLcd(lcd.s, `${process.env.GOLD_SHOTS}/${name}.png`);
    },
  };
  return r;
}

/** A party mon built with battle/Mon.ts against the real data. */
export function mon(game: any, species: string, level: number, opts: Record<string, any> = {}): any {
  const m = Mon.new(game.data, species, level, opts);
  if (!m) throw new Error(`no mon ${species}`);
  Mon.stampOT(game.save, m);
  return m;
}

// ------------------------------------------------------------ stand-ins
//
// Typer, TileSheet, Sprites (group A) and WaitPlaySFX are ported by other
// agents. While a module is still a stub, tests patch in a minimal
// transcription of its Lua so the screens can run. Nothing here ships.

import { Typer } from "../voxelmon/game/gen2/ui/Typer.ts";
import { TileSheet } from "../voxelmon/game/gen2/ui/TileSheet.ts";
import { WaitPlaySFX } from "../voxelmon/game/gen2/ui/WaitPlaySFX.ts";
import { Sprites } from "../voxelmon/game/gen2/shared/pokemon/Sprites.ts";
import { Sound } from "../voxelmon/game/gen2/shared/core/Sound.ts";
import { Font } from "../voxelmon/game/gen2/shared/render/Font.ts";
import { Assets } from "../voxelmon/game/gen2/shared/render/Assets.ts";
import { GbcPalette } from "../voxelmon/game/gen2/shared/render/GbcPalette.ts";
import { G } from "../voxelmon/game/gen2/platform/screen.ts";

const isStub = (f: unknown) => typeof f !== "function" || String(f).includes("notPorted");

const TYPER_DELAYS: Record<string, number> = { FAST: 1, MID: 3, SLOW: 5 };

/** Typer.lua, transcribed (test stand-in only). */
const TyperStatics = {
  DELAYS: TYPER_DELAYS,
  new(game: any, opts: any = {}) {
    const t = Object.create((Typer as any).prototype);
    Object.assign(t, { game, speed: opts.speed, instant: !!opts.instant, expand: opts.expand, shown: 0, total: 0, timer: 0, page: [] });
    return t;
  },
  say(screen: any, pages: any, onDone?: any, opts?: any) {
    screen.message = { pages: pages ?? [], page: 1, onDone };
    screen.typer = (Typer as any).new(screen.game, opts);
    screen.typer.start(screen.message.pages[0]);
    return screen.message;
  },
  begin(screen: any, record: any, opts?: any) {
    screen.typer = (Typer as any).new(screen.game, opts);
    screen.typer.start(record.pages && record.pages[(record.page ?? 1) - 1]);
    return record;
  },
  turn(screen: any, record: any) {
    record.page++;
    if (screen.typer) screen.typer.start(record.pages[record.page - 1]);
  },
  step(screen: any) {
    screen.arrowBlink = ((screen.arrowBlink ?? 0) + 1) % 32;
    return screen.typer ? screen.typer.tick() : true;
  },
  arrowOn(screen: any) {
    return (screen.arrowBlink ?? 0) % 32 < 16;
  },
  typing(screen: any) {
    return screen.typer != null && !screen.typer.done();
  },
  text(screen: any, fallback?: any) {
    return screen.typer ? screen.typer.lines() : fallback;
  },
};

const TyperMethods = {
  start(this: any, page: any) {
    const lines: string[] = page == null ? [] : typeof page === "string" ? page.split("\n") : page;
    let total = 0;
    let kept = 0;
    const out: string[] = [];
    lines.forEach((line, i) => {
      const text = this.expand ? this.expand(line) : line;
      out.push(text);
      const n = Font.split(text).length;
      total += n;
      if (page && typeof page === "object" && page.scrolled && i === 0) kept = n;
    });
    this.page = out;
    this.total = total;
    this.shown = this.instant ? total : kept;
    this.timer = 0;
  },
  delay(this: any) {
    if (this.instant) return 0;
    const raw = this.speed ?? this.game?.save?.options?.textSpeed;
    let d = TYPER_DELAYS[raw] ?? (Number(raw) || 3);
    if (d !== 1 && d !== 3 && d !== 5) d = 3;
    const input = this.game?.input;
    if (input?.isDown && (input.isDown("a") || input.isDown("b"))) d = 1;
    return d;
  },
  done(this: any) {
    return this.shown >= this.total;
  },
  tick(this: any) {
    if (this.done()) return true;
    const d = this.delay();
    if (d <= 0) {
      this.shown = this.total;
      return true;
    }
    if (this.timer >= d) this.timer = d - 1;
    this.timer++;
    while (this.timer >= d && this.shown < this.total) {
      this.timer -= d;
      this.shown++;
    }
    return this.done();
  },
  lines(this: any) {
    if (this.done()) return this.page;
    let left = this.shown;
    return this.page.map((line: string) => {
      const spans = Font.split(line);
      let r: string;
      if (left >= spans.length) r = line;
      else if (left <= 0) r = "";
      else r = line.slice(0, spans[left - 1]!.to);
      left -= spans.length;
      return r;
    });
  },
};

/** TileSheet.lua, transcribed (test stand-in only). */
const TileSheetStatics = {
  new(opts: any = {}) {
    const t = Object.create((TileSheet as any).prototype);
    Object.assign(t, {
      path: opts.path, wide: opts.wide ?? 16, firstTile: opts.firstTile ?? 0, palette: opts.palette,
      paletteFor: opts.paletteFor, raw: opts.raw, quads: {}, loaded: undefined,
    });
    return t;
  },
};

const TileSheetMethods = {
  image(this: any) {
    if (this.loaded === undefined) {
      this.loaded = false;
      if (this.path) {
        try {
          this.loaded = Assets.image(this.path) || false;
        } catch {
          // pcall
        }
      }
    }
    return this.loaded || null;
  },
  available(this: any) {
    return this.image() != null;
  },
  quad(this: any, index: number) {
    let q = this.quads[index];
    if (!q) {
      const img: any = this.image();
      if (!img) return null;
      const [w, h] = img.getDimensions();
      q = G.newQuad((index % this.wide) * 8, Math.floor(index / this.wide) * 8, 8, 8, w, h);
      this.quads[index] = q;
    }
    return q;
  },
  draw(this: any, tile: number, tx: number, ty: number) {
    const img: any = this.image();
    if (!img) return false;
    const index = tile - this.firstTile;
    if (index < 0) return false;
    const q: any = this.quad(index);
    if (!q) return false;
    const sy = q.getViewport ? q.getViewport()[1] : q.y;
    if (sy >= img.getDimensions()[1]) return false;
    G.setColor(1, 1, 1, 1);
    let colors = this.palette;
    if (this.paletteFor) colors = this.paletteFor(tile, tx, ty) ?? colors;
    const body = () => G.draw(img, q, tx * 8, ty * 8);
    const P: any = GbcPalette;
    if (colors && P.available()) (this.raw && P.withRaw ? P.withRaw : P.with).call(P, colors, body);
    else body();
    return true;
  },
  run(this: any, first: number, count: number, tx: number, ty: number) {
    for (let i = 0; i < count; i++) this.draw(first + i, tx + i, ty);
  },
  block(this: any, first: number, wide: number, high: number, tx: number, ty: number) {
    for (let r = 0; r < high; r++) for (let c = 0; c < wide; c++) this.draw(first + r * wide + c, tx + c, ty + r);
  },
};

let standInsDone: string[] | null = null;

/**
 * Patch in the stand-ins for whatever is still a stub; returns their names.
 * Call once at the top of a test file.
 */
export function standIns(): string[] {
  if (standInsDone) return standInsDone;
  const used: string[] = [];
  if (isStub((Typer as any).new)) {
    Object.assign(Typer as any, TyperStatics);
    Object.assign((Typer as any).prototype, TyperMethods);
    used.push("Typer");
  }
  if (isStub((TileSheet as any).new)) {
    Object.assign(TileSheet as any, TileSheetStatics);
    Object.assign((TileSheet as any).prototype, TileSheetMethods);
    used.push("TileSheet");
  }
  const S: any = Sprites;
  if (isStub(S.pic)) {
    S.pic = (path: any) => path;
    S.path = (data: any, species: string, side?: string) => {
      const def = data?.pokemon?.[species];
      if (!def) return undefined;
      return side === "back" ? def.spriteBack : def.spriteFront;
    };
    S.playerPic = (path: any) => path;
    S.playerPath = () => undefined;
    S.iconPath = (_d: any, _m: any, vanillaPath: any) => vanillaPath;
    used.push("Sprites");
  }
  const W: any = WaitPlaySFX;
  if (isStub(W.arm)) {
    W.arm = (name: string, fallback?: number) => {
      const S2: any = Sound;
      const frames = S2.waitFramesFor ? S2.waitFramesFor(name, fallback ?? 30) : 0;
      return { name, left: Number(frames) || 0 };
    };
    W.waiting = (p: any) => {
      if (!p) return false;
      p.left = (p.left ?? 0) - 1;
      if (p.left <= 0) return false;
      const S2: any = Sound;
      if (S2.sfxBusy && S2.sfxBusy()) return true;
      return (S2.isPlaying && S2.isPlaying(p.name)) || false;
    };
    used.push("WaitPlaySFX");
  }
  standInsDone = used;
  return used;
}
