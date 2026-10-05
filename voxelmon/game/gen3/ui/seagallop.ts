// Port of gen1recomp src/ui/game3/seagallop.lua (GPLv3 + additional terms; see LICENSE.md).
// Seagallop high-speed ferry cutscene (FRLG 1:1)
// pokefirered/src/seagallop.c
//
// Lua's `package.loaded["src.X"]` / `pcall(require, "src.X")` become the
// static imports below (every module is in the bundle); Brian's `X and X.f`
// guards and his pcall around calls are kept.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { mod, tonumber } from "../../../import/gen3/lua.ts";
import { insert, ipairs, len, remove, seq } from "../platform/lt.ts";
import { gsub } from "../platform/lpattern.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type Quad } from "../platform/image.ts";
import { Fs } from "../platform/fs.ts";
import { Fade } from "./fade.ts";
import { Message as StayMessage } from "./message.ts";
import { SE } from "../core/se_ids.ts";
import { Audio } from "../core/audio.ts";
import { Dataset } from "../core/dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";

const W = 240, H = 160;
// pokefirered/include/constants/songs.h:23 (SE, imported above)
const CROSSING_FRAMES = 140;
const MUSIC_FADE_FRAMES = 64;

const DIRN_WESTBOUND = 0;
const DIRN_EASTBOUND = 1;

// pokefirered/src/seagallop.c:88
const TRAVEL_DIRECTIONS: Record<number, number> = {
  0: 0x6fe, // VERMILION_CITY
  1: 0x6fc, // ONE_ISLAND
  2: 0x6f8, // TWO_ISLAND
  3: 0x6f0, // THREE_ISLAND
  4: 0x6e0, // FOUR_ISLAND
  5: 0x4c0, // FIVE_ISLAND
  6: 0x400, // SIX_ISLAND
  7: 0x440, // SEVEN_ISLAND
  8: 0x7ff, // CINNABAR_ISLAND
  9: 0x6e0, // NAVEL_ROCK
  10: 0x000, // BIRTH_ISLAND
};

const CACHE_ROOT = "data/generated/gba/seagallop";

export interface SeagallopAssets {
  wb: Image | undefined;
  eb: Image | undefined;
  ferry: Image | undefined;
  wake: Image | undefined;
  wakeQuads: (Quad | null)[] | undefined;
}

export interface Wake { x: number; y: number; frame: number; tick: number }

export interface SeagallopRun {
  origin: unknown;
  dest: unknown;
  direction: number;
  onWarp: (() => void) | undefined;
  onDone: (() => void) | undefined;
  tick: number;
  accum: number;
  bgX: number;
  ferryX: number;
  ferryY: number;
  wakes: (Wake | null)[];
  state: "running" | "fading" | "done";
  waited?: number;
}

// Lua: seagallop.lua:45
// NOT FAITHFUL: no io.open on the 3DS. The last-resort OS reads (the relative
// path, its data/generated/gba form and the LÖVE save directories under HOME)
// are dropped; the first two are already read through love.filesystem above.
function read_bytes(rel: string): string | undefined {
  if (CacheFs && CacheFs.readActive) {
    const d = CacheFs.readActive(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  if (Dataset && Dataset.cache) {
    const d = Dataset.cache().read(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  {
    let d = Fs.read(rel);
    if (typeof d === "string" && d.length > 0) return d;
    const alt = "data/generated/gba/" + gsub(rel, "^data/generated/gba/", "")[0];
    d = Fs.read(alt);
    if (typeof d === "string" && d.length > 0) return d;
  }
  return undefined;
}

// Lua: seagallop.lua:82
function rgba_to_image(raw: string | undefined, w: number, h: number): Image | undefined {
  if (!raw || raw.length < w * h * 4) return undefined;
  let imgData;
  try {
    imgData = newImageData(w, h, "rgba8", raw);
  } catch {
    return undefined;
  }
  if (!imgData) return undefined;
  const img = G.newImage(imgData);
  if (img.setFilter) img.setFilter("nearest", "nearest");
  if (img.setWrap) img.setWrap("repeat", "repeat");
  return img;
}

// Lua: seagallop.lua:93
function loadAssets(): SeagallopAssets {
  if (Seagallop._assets) return Seagallop._assets;

  const wbRaw = read_bytes(CACHE_ROOT + "/wb.rgba");
  const ebRaw = read_bytes(CACHE_ROOT + "/eb.rgba");
  const ferryRaw = read_bytes(CACHE_ROOT + "/ferry.rgba");
  const wakeRaw = read_bytes(CACHE_ROOT + "/wake.rgba");

  const wbImg = rgba_to_image(wbRaw, 256, 256);
  const ebImg = rgba_to_image(ebRaw, 256, 256);
  const ferryImg = rgba_to_image(ferryRaw, 64, 40);
  const wakeImg = rgba_to_image(wakeRaw, 32, 128);

  let wakeQuads: (Quad | null)[] | undefined = undefined;
  if (wakeImg && G.newQuad) {
    wakeQuads = seq(
      G.newQuad(0, 0, 32, 32, 32, 128),
      G.newQuad(0, 32, 32, 32, 32, 128),
      G.newQuad(0, 64, 32, 32, 32, 128),
    );
  }

  Seagallop._assets = {
    wb: wbImg,
    eb: ebImg,
    ferry: ferryImg,
    wake: wakeImg,
    wakeQuads,
  };
  return Seagallop._assets;
}

// Lua: seagallop.lua:170
function stepTick(run: SeagallopRun): void {
  run.tick = run.tick + 1;

  // 6.0 pixels per tick for water background (0x600 8.8 fixed-point displacement)
  // 3.0 pixels per tick for ferry (48 subpixels: 48 >> 4)
  if (run.direction === DIRN_EASTBOUND) {
    run.bgX = mod(run.bgX + 6.0, 256);
    run.ferryX = run.ferryX + 3.0;
  } else {
    run.bgX = mod(run.bgX - 6.0, 256);
    run.ferryX = run.ferryX - 3.0;
  }

  // Spawn wake every 5 ticks
  if (mod(run.tick, 5) === 0) {
    insert(run.wakes, {
      x: run.ferryX,
      y: run.ferryY,
      frame: 1,
      tick: 0,
    });
  }

  // Update wake animation (20 frames, 20 frames, 15 frames)
  let i = 1;
  while (i <= len(run.wakes)) {
    const w = run.wakes[i]!;
    w.tick = w.tick + 1;
    if (w.tick < 20) {
      w.frame = 1;
    } else if (w.tick < 40) {
      w.frame = 2;
    } else if (w.tick < 55) {
      w.frame = 3;
    } else {
      remove(run.wakes, i);
      i = i - 1;
    }
    i = i + 1;
  }

  // pokefirered/src/seagallop.c:286
  if (run.tick >= CROSSING_FRAMES && run.state === "running") {
    run.state = "fading";
    run.waited = 0;
    if (Audio && Audio.fadeOutBgm) {
      try { Audio.fadeOutBgm(4); } catch { /* pcall */ }
    }
    Fade.begin(Fade.MODE.TO_BLACK, 1);
    return;
  }
  if (run.state !== "fading") return;
  // pokefirered/src/seagallop.c:297
  run.waited = run.waited! + 1;
  if (Fade.isActive()) return;
  // pcall(require, "src.core.game3.audio") always succeeds here.
  if (Audio && Audio._fadeOut && run.waited < MUSIC_FADE_FRAMES) return;
  // pokefirered/src/seagallop.c:305
  run.state = "done";
  Seagallop.stop();
  if (Audio && Audio.playSe) {
    try { Audio.playSe(SE.SE_EXIT); } catch { /* pcall */ }
  }
  if (run.onWarp) {
    run.onWarp();
  }
  if (run.onDone) {
    run.onDone();
  }
}

export const Seagallop = {
  _assets: undefined as SeagallopAssets | undefined,
  _active: false,
  _run: undefined as SeagallopRun | undefined,

  // Lua: seagallop.lua:37
  directionOfTravel(originIdIn: unknown, destIdIn: unknown): number {
    const originId = tonumber(originIdIn) ?? 0;
    const destId = tonumber(destIdIn) ?? 0;
    const mask = TRAVEL_DIRECTIONS[originId];
    if (mask == null) return DIRN_EASTBOUND;
    return (mod(Math.floor(mask / Math.pow(2, destId)), 2) === 1) ? DIRN_EASTBOUND : DIRN_WESTBOUND;
  },

  // Lua: seagallop.lua:125
  start(originId: unknown, destId: unknown, onWarp?: () => void, onDone?: () => void): boolean {
    {
      if (StayMessage && StayMessage.closeStay) StayMessage.closeStay();
    }
    const dir = Seagallop.directionOfTravel(originId, destId);
    const run: SeagallopRun = {
      origin: originId,
      dest: destId,
      direction: dir,
      onWarp,
      onDone,
      tick: 0,
      accum: 0,
      bgX: 0,
      ferryX: (dir === DIRN_EASTBOUND) ? 0 : 240,
      ferryY: 92,
      wakes: seq(),
      state: "running",
    };

    if (Audio && Audio.playSe) {
      try { Audio.playSe(SE.SE_SHIP); } catch { /* pcall */ }
    }

    Seagallop._run = run;
    Seagallop._active = true;
    loadAssets();

    // pokefirered/src/seagallop.c:229: Fade in from black as cutscene starts
    Fade.begin(Fade.MODE.FROM_BLACK, 0.3);

    return true;
  },

  // Lua: seagallop.lua:161
  isActive(): boolean {
    return Seagallop._active && Seagallop._run != null;
  },

  // Lua: seagallop.lua:165
  stop(): void {
    Seagallop._active = false;
    Seagallop._run = undefined;
  },

  // Lua: seagallop.lua:243
  update(dt?: number): void {
    const run = Seagallop._run;
    if (!run) return;

    run.accum = run.accum + (dt ?? (1 / 60));
    let maxTicks = 10;
    while (run.accum >= (1 / 60) && maxTicks > 0) {
      run.accum = run.accum - (1 / 60);
      maxTicks = maxTicks - 1;
      stepTick(run);
    }
  },

  // Lua: seagallop.lua:256
  draw(): void {
    const run = Seagallop._run;
    if (!run) return;
    const assets = loadAssets();

    const cw = G.getWidth ? G.getWidth() : W;
    const ch = G.getHeight ? G.getHeight() : H;
    const maxW = Math.max(cw, W, 800);
    const maxH = Math.max(ch, H, 600);

    // Solid black full-screen background
    G.setColor(0, 0, 0, 1);
    G.rectangle("fill", -maxW, -maxH, maxW * 3, maxH * 3);
    G.setColor(1, 1, 1, 1);

    // GBA WIN0 letterbox scissor (Y: 24 to 136)
    G.setScissor(0, 24, W, 112);

    if (assets && assets.wb && assets.eb) {
      const bg = (run.direction === DIRN_EASTBOUND) ? assets.eb : assets.wb;
      const ox = Math.floor(run.bgX);
      let startX = -ox;
      while (startX > 0) startX = startX - 256;
      for (let x = startX; x <= W; x += 256) {
        G.draw(bg, x, 0);
      }

      // Wakes
      if (assets.wake && assets.wakeQuads) {
        const scaleX = (run.direction === DIRN_EASTBOUND) ? -1 : 1;
        for (const [, w] of ipairs<Wake>(run.wakes)) {
          const q = assets.wakeQuads[w.frame] ?? assets.wakeQuads[1]!;
          G.draw(assets.wake, q, Math.floor(w.x), Math.floor(w.y), 0, scaleX, 1, 16, 16);
        }
      }

      // Ferry
      if (assets.ferry) {
        const scaleX = (run.direction === DIRN_EASTBOUND) ? -1 : 1;
        G.draw(assets.ferry, Math.floor(run.ferryX), Math.floor(run.ferryY), 0, scaleX, 1, 32, 20);
      }
    } else {
      G.setColor(0.18, 0.44, 0.75, 1);
      G.rectangle("fill", 0, 24, W, 112);
    }

    G.setScissor();

    // Top and bottom black letterbox bars (and side borders)
    G.setColor(0, 0, 0, 1);
    G.rectangle("fill", -maxW, -maxH, maxW * 3, maxH + 24);
    G.rectangle("fill", -maxW, 136, maxW * 3, maxH * 2);
    G.rectangle("fill", -maxW, 0, maxW, H);
    G.rectangle("fill", W, 0, maxW, H);
    G.setColor(1, 1, 1, 1);
  },
};

export default Seagallop;
