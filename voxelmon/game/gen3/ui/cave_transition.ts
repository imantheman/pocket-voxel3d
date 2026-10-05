// Port of gen1recomp src/ui/game3/cave_transition.lua (GPLv3 + additional terms; see LICENSE.md).
// The cave entrance / exit flash (pokefirered src/fldeff_flash.c:288 and
// :356): the cave_transition screen and palettes from the cache, stepped
// one GBA frame at a time and drawn as a 240x160 image.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Dataset } from "../core/dataset.ts";
import { Message } from "./message.ts";
import { Renderer } from "../shared/render/Renderer.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type ImageData } from "../platform/image.ts";
import { luaLoad } from "../platform/luadata.ts";
import { seq, type LuaTable } from "../platform/lt.ts";

const W = 240, H = 160;
const SCREEN_REL = "data/generated/gba/cave_transition/screen.bin";
const PALETTES_REL = "data/generated/gba/cave_transition/palettes.lua";

/** A BGR555 colour split into 5-bit channels {r, g, b} (a Lua sequence). */
type Rgb5 = LuaTable;
/** A 16-colour palette keyed 0..15. */
type Pal = Rgb5[];

interface Assets { screen: string; pals: any }

export interface CaveRun {
  kind: string;
  done: (() => void) | undefined;
  task: string;
  pal14: Pal;
  backdrop: Rgb5;
  blend: boolean;
  eva: number;
  evb: number;
  showBg0: boolean;
  d1: number;
  d2: number;
  frame: number;
  defer?: boolean;
}

// The src.render.Renderer probe: the module is always present here (inert on
// the 3DS). Read at call time: no top-level reads of imports (module cycle).
function renderer(): Record<string, any> {
  return Renderer as unknown as Record<string, any>;
}

// Lua: cave_transition.lua:13
function loadAssets(): Assets {
  if (CaveTransition._assets) return CaveTransition._assets;
  const cache = Dataset.cache();
  const screen = cache.read(SCREEN_REL);
  const src = cache.read(PALETTES_REL);
  if (!(typeof screen === "string" && screen.length === W * H)) throw new Error("cave_transition screen.bin missing from the cache");
  if (typeof src !== "string") throw new Error("cave_transition palettes.lua missing from the cache");
  const [chunk, err] = luaLoad(src, "@" + PALETTES_REL);
  if (!chunk) throw new Error(err);
  const pals = chunk();
  CaveTransition._assets = { screen, pals };
  return CaveTransition._assets;
}

// Lua: cave_transition.lua:26
function bgr555(c: number): Rgb5 {
  return seq(c % 32, Math.floor(c / 32) % 32, Math.floor(c / 1024) % 32);
}

// Lua: cave_transition.lua:30
function copyPal(src: any): Pal {
  const out: Pal = [];
  for (let i = 0; i <= 15; i++) out[i] = bgr555(src[i]);
  return out;
}

// Lua: cave_transition.lua:36
function loadPalette(dst: Pal, src: any, srcStart: number, count: number): void {
  for (let i = 0; i <= count - 1; i++) dst[i] = bgr555(src[srcStart + i]);
}

// Lua: cave_transition.lua:40
function newRun(kind: string, done: (() => void) | undefined): CaveRun {
  const a = loadAssets();
  return {
    kind,
    done,
    task: "0",
    pal14: copyPal(a.pals.white),
    backdrop: bgr555(a.pals[kind === "exit" ? "black" : "white"][0]),
    blend: false,
    eva: 16,
    evb: 0,
    showBg0: false,
    d1: 0,
    d2: 0,
    frame: 0,
  };
}

// Lua: cave_transition.lua:75
function finish(run: CaveRun): void {
  CaveTransition._run = undefined;
  if (run.done) run.done();
}

// Lua: cave_transition.lua:80
function stepEnter(run: CaveRun, a: Assets): void {
  const t = run.task;
  if (t === "0") {
    run.task = "1";
  } else if (t === "1") {
    // src/fldeff_flash.c:366
    run.showBg0 = true;
    run.blend = false;
    run.pal14 = copyPal(a.pals.white);
    run.backdrop = bgr555(a.pals.black[0]);
    run.task = "2";
    [run.d1, run.d2] = [0, 0];
  } else if (t === "2") {
    // src/fldeff_flash.c:384
    const count = run.d2;
    if (count < 16) {
      run.d2 = run.d2 + 2;
      for (let i = 0; i <= count; i++) run.pal14[i] = bgr555(a.pals.tiles[15 - count + i]);
    } else {
      run.blend = true;
      [run.eva, run.evb] = [16, 16];
      run.task = "3";
    }
  } else if (t === "3") {
    // src/fldeff_flash.c:401
    const r4 = 16 - run.d1;
    [run.eva, run.evb] = [r4, 16];
    if (r4 !== 0) {
      run.d1 = run.d1 + 1;
    } else {
      run.backdrop = bgr555(a.pals.black[0]);
      finish(run);
    }
  }
}

// Lua: cave_transition.lua:116
function stepExit(run: CaveRun, a: Assets): void {
  const t = run.task;
  if (t === "0") {
    run.task = "1";
  } else if (t === "1") {
    // src/fldeff_flash.c:298
    run.showBg0 = true;
    run.pal14 = copyPal(a.pals.white);
    loadPalette(run.pal14, a.pals.tiles, 8, 8);
    run.blend = true;
    [run.eva, run.evb] = [0, 0];
    run.task = "2";
    run.d1 = 0;
  } else if (t === "2") {
    // src/fldeff_flash.c:315
    const r4 = run.d1;
    [run.eva, run.evb] = [Math.min(r4, 16), 16];
    if (r4 <= 16) {
      run.d1 = run.d1 + 1;
    } else {
      run.d2 = 0;
      run.task = "3";
    }
  } else if (t === "3") {
    // src/fldeff_flash.c:330
    [run.eva, run.evb] = [16, 16];
    const count = run.d2;
    if (count < 8) {
      run.d2 = run.d2 + 1;
      loadPalette(run.pal14, a.pals.tiles, count + 8, 8 - count);
    } else {
      run.backdrop = bgr555(a.pals.white[0]);
      run.task = "4";
      run.d2 = 8;
    }
  } else if (t === "4") {
    // src/fldeff_flash.c:348
    if (run.d2 !== 0) {
      run.d2 = run.d2 - 1;
    } else {
      finish(run);
    }
  }
}

// Lua: cave_transition.lua:180
function blendChannel(top: number, below: number, eva: number, evb: number): number {
  let v = Math.floor((top * eva + below * evb) / 16);
  if (v > 31) v = 31;
  return v;
}

// Lua: cave_transition.lua:186
function outColor(run: CaveRun, i: number): Rgb5 {
  const c = run.pal14[i]!;
  const b = run.backdrop;
  if (!run.blend) return c;
  return seq(
    blendChannel(c[1], b[1], run.eva, run.evb),
    blendChannel(c[2], b[2], run.eva, run.evb),
    blendChannel(c[3], b[3], run.eva, run.evb),
  );
}

// Lua: cave_transition.lua:208
function rebuild(run: CaveRun): void {
  const a = loadAssets();
  if (!CaveTransition._imageData) {
    CaveTransition._imageData = newImageData(W, H);
  }
  const lut: LuaTable[] = [];
  for (let i = 1; i <= 15; i++) {
    const c = run.showBg0 ? outColor(run, i) : run.backdrop;
    lut[i] = seq(c[1] / 31, c[2] / 31, c[3] / 31);
  }
  const b = run.backdrop;
  lut[0] = seq(b[1] / 31, b[2] / 31, b[3] / 31);
  const screen = a.screen;
  // Brian's callback returns four values; one reused tuple stands for them
  const ret: [number, number, number, number] = [0, 0, 0, 1];
  CaveTransition._imageData.mapPixel((x, y) => {
    const c = lut[screen.charCodeAt(y * W + x) % 16]!;
    ret[0] = c[1]; ret[1] = c[2]; ret[2] = c[3]; ret[3] = 1;
    return ret;
  });
  if (CaveTransition._image) {
    CaveTransition._image.replacePixels(CaveTransition._imageData);
  } else {
    CaveTransition._image = G.newImage(CaveTransition._imageData);
    CaveTransition._image.setFilter("nearest", "nearest");
  }
  CaveTransition._dirty = false;
}

export const CaveTransition = {
  _run: undefined as CaveRun | undefined,
  _assets: undefined as Assets | undefined,
  _dirty: false,
  _imageData: undefined as ImageData | undefined,
  _image: undefined as Image | undefined,

  // src/fldeff_flash.c:475
  // Lua: cave_transition.lua:59
  start(kind: string, done?: () => void, skipFirstTask?: boolean): boolean {
    {
      // package.loaded["src.ui.game3.message"]: always loaded here
      const StayMessage = Message;
      if (StayMessage && StayMessage.closeStay) StayMessage.closeStay();
    }
    const run = newRun(kind, done);
    if (skipFirstTask) run.task = "1"; else run.defer = true;
    CaveTransition._run = run;
    CaveTransition._dirty = true;
    return true;
  },

  // Lua: cave_transition.lua:71
  isActive(): boolean {
    return CaveTransition._run != null;
  },

  // Lua: cave_transition.lua:161
  update(dt?: number): void {
    let run = CaveTransition._run;
    if (!run) return;
    let steps = Math.floor(((dt ?? (1 / 60)) * 60) + 0.5);
    if (steps < 1) steps = 1;
    const a = loadAssets();
    for (let s = 1; s <= steps; s++) {
      run = CaveTransition._run;
      if (!run) return;
      if (run.defer) {
        run.defer = false;
      } else {
        run.frame = run.frame + 1;
        if (run.kind === "exit") stepExit(run, a); else stepEnter(run, a);
        CaveTransition._dirty = true;
      }
    }
  },

  // Lua: cave_transition.lua:197
  colorAt(x: number, y: number): Rgb5 | undefined {
    const run = CaveTransition._run;
    if (!run) return undefined;
    if (!run.showBg0) return run.backdrop;
    const a = loadAssets();
    const byte = a.screen.charCodeAt(y * W + x);
    const idx = byte % 16;
    if (idx === 0) return run.backdrop;
    return outColor(run, idx);
  },

  // Lua: cave_transition.lua:234
  surroundColor(): LuaTable | undefined {
    const c = CaveTransition.colorAt(0, 0);
    if (!c) return undefined;
    return seq(c[1] / 31, c[2] / 31, c[3] / 31);
  },

  // Lua: cave_transition.lua:240
  draw(): void {
    const run = CaveTransition._run;
    if (!run) return;
    if (CaveTransition._dirty || !CaveTransition._image) rebuild(run);
    G.setColor(1, 1, 1, 1);
    G.draw(CaveTransition._image!, 0, 0);
    const s = CaveTransition.surroundColor();
    // package.loaded["src.render.Renderer"]
    const R = renderer();
    if (R && s) {
      R.voidVeil = seq(s[1], s[2], s[3], 1);
    }
  },

  // Lua: cave_transition.lua:253
  clear(): void {
    CaveTransition._run = undefined;
  },
};

export default CaveTransition;
