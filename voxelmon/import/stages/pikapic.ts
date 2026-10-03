// Yellow's PIKAPIC: the starter PIKACHU's framed face when you talk to it
// (engine/pikachu/pikachu_pic_animation.asm, data/pikachu/*).
//
// On the cart a face is a little program. ExecutePikaPicAnimScript runs once
// per tick (Delay3, so three frames): the setup script's commands until
// `waitbgmap` -- loadgfx puts a compressed pic or raw 2bpp tiles into the
// next free tiles from $80, `animation` starts one of four objects -- then
// every object draws its frame set's current tilemap into the 5x5 box at
// (7,6), the first object the whole face, the next the blinking eyes or the
// open mouth over it. A frame set lists (tilemap, ticks) pairs, a tilemap of
// 0 drawing nothing for its ticks and $e0 looping; a tilemap's $ff cells
// leave the box alone. The face ends when its tick count runs out (or on A
// or B), with `cry` playing a PIKACHU clip and `thunderbolt` flashing the
// screen on the way.
//
// Rather than ship that program, it is RUN here, once per script, and what
// it drew is kept: each distinct frame as a picture (gfx pikapic/fNNN, raw
// shades 0-3, the cook makes them pages) -- 56x56, the 5x5 face inside
// PlacePikapicTextBoxBorder's frame drawn from the ROM's own TextBoxGraphics
// border tiles, so the picture is the whole box -- and per script the frame of
// every tick plus the tick its cry and thunderbolt fall on (pikapic.json).
// The game then only plays a list of pictures.
//
// The manifest names none of these tables. They are found in bank $3F by
// their own first bytes, which the disassembly fixes -- the GFX headers open
// with Pic_e4000 at $39:$4000, script 0 with setduration 40 and two loads,
// frame set 0 with tilemap 1 for 20 ticks, tilemap 1 with the 5x5 pic map --
// and each pointer table by the words that point at them. US Yellow: headers
// $3F:6572, scripts $3F:5A5E, frame sets $3F:5BC9, tilemaps $3F:5DB8.
import type { Ctx } from "../ctx.ts";
import { decode2bpp } from "../gfx.ts";
import { decompressPic } from "../rom.ts";

const BANK = 0x3f;
const SCRIPTS = 30; // PikaPicAnimPointers, $00-$1d
const FRAME_SETS = 36; // PikaPicAnimBGFramesPointers, $00-$23
const GFX_HEADERS = 63; // PikaPicAnimGFXHeaders, $00-$3e
const BOX = 5; // tiles each way
const SPACE = -1; // the box's blank (TextBoxBorder's fill)
const MAX_TICKS = 400;

const GFX_START = [0x01, 0x39, 0x00, 0x00, 0xff, 0x39, 0x00, 0x40, 0x05, 0x39, 0xcc, 0x40];
const SCRIPT0_START = [0x0a, 0x28, 0x00, 0x02, 0x01, 0x02, 0x02, 0x03, 0x04, 0x00, 0x80, 0x00, 0x00];
const FRAMES0_START = [0x01, 0x14, 0x07, 0x02, 0x01, 0x01, 0x07, 0x02, 0x01, 0x01, 0x07, 0x08, 0xe0];
const TILEMAP1_START = [5, 5, 0x00, 0x05, 0x0a, 0x0f, 0x14, 0x01, 0x06, 0x0b, 0x10, 0x15];

interface Rom {
  byte(bank: number, address: number): number;
  bytes(bank: number, address: number, n: number): number[];
  word(bank: number, address: number): number;
}

export interface PikapicScript {
  /** Frame index (into the pictures) of every tick, three frames a tick. */
  ticks: number[];
  /** The tick its `cry` falls on, and the clip (PikachuCryN), if it has one. */
  cry?: { tick: number; clip: number };
  /** The tick its `thunderbolt` flashes on, if any. */
  thunderbolt?: number;
  /** That tick's frame under the flash's rBGP %11000000 (black stays, the
   *  rest goes white): .FlashScreen alternates it with the frame, four
   *  frames each, ten times over. */
  flash?: number;
}

export interface PikapicData {
  frames: number;
  scripts: PikapicScript[];
}

function find(rom: Rom, pattern: number[], from = 0x4000): number | null {
  for (let a = from; a + pattern.length <= 0x8000; a++) {
    let ok = true;
    for (let i = 0; i < pattern.length && ok; i++) ok = rom.byte(BANK, a + i) === pattern[i];
    if (ok) return a;
  }
  return null;
}

/** The pointer table whose entries `at` and `at + k` both hold `target`. */
function findTable(rom: Rom, target: number, also: number): number | null {
  for (let a = 0x4000; a + 2 * (also + 1) <= 0x8000; a++) {
    if (rom.word(BANK, a) === target && rom.word(BANK, a + also * 2) === target) return a;
  }
  return null;
}

export function extractPikapic(ctx: Ctx): PikapicData | null {
  const rom = (ctx as unknown as { rom: Rom }).rom;
  const gfx = (ctx as unknown as { gfx: { add(key: string, image: unknown): void } }).gfx;
  const headers = find(rom, GFX_START);
  const script0 = find(rom, SCRIPT0_START);
  const frames0 = find(rom, FRAMES0_START);
  const tilemap1 = find(rom, TILEMAP1_START);
  if (headers === null || script0 === null || frames0 === null || tilemap1 === null) return null;
  // script 0 = 1 = 29; frame set 0 = 1; tilemap 1 = 42, after the lone $ff of 0
  const scriptPtrs = findTable(rom, script0, 1);
  const framePtrs = findTable(rom, frames0, 1);
  const tilemapRef = findTable(rom, tilemap1, 41);
  if (scriptPtrs === null || framePtrs === null || tilemapRef === null) return null;
  const tilemapPtrs = tilemapRef - 2;

  /** loadgfx: one header's tiles, in VRAM order (a pic's columns run down). */
  const tilesOf = (id: number): number[][] => {
    if (id < 0 || id >= GFX_HEADERS) return [];
    const at = headers + id * 4;
    const size = rom.byte(BANK, at);
    const bank = rom.byte(BANK, at + 1);
    const address = rom.word(BANK, at + 2);
    if (address < 0x4000) return [];
    if (size === 0xff) {
      const [raw, w] = decompressPic(rom.bytes(bank, address, 0x8000 - address));
      // decompressPic hands back row-major tiles; VRAM has them column-major
      const out: number[][] = [];
      for (let n = 0; n < w * w; n++) {
        const t = (n % w) * w + Math.floor(n / w);
        out.push(raw.slice(t * 16, t * 16 + 16));
      }
      return out;
    }
    const out: number[][] = [];
    for (let n = 0; n < size; n++) out.push(rom.bytes(bank, address + n * 16, 16));
    return out;
  };

  const frameKeys = new Map<string, number>();
  const frameImages: number[][] = [];
  const scripts: PikapicScript[] = [];

  for (let s = 0; s < SCRIPTS - 1; s++) {
    const vram = new Map<number, number[]>();
    const used: { id: number; at: number }[] = [];
    let count = 0;
    let ptr = rom.word(BANK, scriptPtrs + s * 2);
    let timer = 100;
    let delay = 0;
    const objects: ({ id: number; set: number; frame: number; t: number; vtile: number; x: number; y: number } | null)[] =
      [null, null, null, null];
    let made = 0;
    const grid: number[] = new Array(BOX * BOX).fill(SPACE);
    const script: PikapicScript = { ticks: [] };
    const next = (): number => rom.byte(BANK, ptr++);

    for (let tick = 0; tick < MAX_TICKS; tick++) {
      // RunPikaPicAnimSetupScript
      if (delay > 0) delay--;
      else {
        for (let guard = 0; guard < 64; guard++) {
          const op = next();
          if (op === 0x0d) break; // waitbgmap: this tick's setup is done
          if (op === 0x0e) { timer = 1; break; } // ret
          if (op === 0x01) delay = next();
          else if (op === 0x02) {
            const id = next();
            const tiles = tilesOf(id);
            const compressed = rom.byte(BANK, headers + id * 4) === 0xff;
            let slot = used.find((u) => u.id === id);
            if (!slot) {
              const size = compressed ? 25 : tiles.length;
              if (used.length >= 8 || count + size > 0x80) continue;
              slot = { id, at: 0x80 + count };
              used.push(slot);
              count += size;
            }
            tiles.forEach((t, i) => vram.set(slot!.at + i, t));
          } else if (op === 0x03) {
            const free = objects.findIndex((o) => o === null);
            const set = next();
            next();
            const vtile = next();
            const x = next();
            const y = next();
            if (free >= 0) objects[free] = { id: ++made, set, frame: 0, t: 0, vtile, x, y };
          } else if (op === 0x06) {
            const id = next();
            const at = objects.findIndex((o) => o?.id === id);
            if (at >= 0) objects[at] = null;
          } else if (op === 0x09) {
            const lo = next();
            ptr = lo | (next() << 8);
          } else if (op === 0x0a) {
            const lo = next();
            timer = lo | (next() << 8);
          } else if (op === 0x0b) {
            const clip = next();
            if (clip !== 0xff && !script.cry) script.cry = { tick, clip: clip + 1 };
          } else if (op === 0x0c) {
            if (script.thunderbolt === undefined) script.thunderbolt = tick;
          }
        }
      }
      // AnimateCurrentPikaPicAnimFrame
      for (const o of objects) {
        if (!o) continue;
        for (let guard = 0; guard < 4; guard++) {
          const set = o.set < 0x23 ? o.set : 4;
          const at = rom.word(BANK, framePtrs + set * 2) + o.frame * 2;
          const map = rom.byte(BANK, at);
          if (map === 0xe0) { o.frame = 0; o.t = 0; continue; }
          if (map !== 0) {
            let mp = rom.word(BANK, tilemapPtrs + map * 2);
            const rows = rom.byte(BANK, mp++);
            const cols = rom.byte(BANK, mp++);
            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < cols; c++) {
                const v = rom.byte(BANK, mp++);
                const gx = o.x + c;
                const gy = o.y + r;
                if (v === 0xff || gx >= BOX || gy >= BOX) continue;
                grid[gy * BOX + gx] = (v + o.vtile) & 0xff;
              }
            }
          }
          const dur = rom.byte(BANK, at + 1);
          if (dur !== 0 && ++o.t === dur) { o.t = 0; o.frame++; }
          break;
        }
      }
      // the box as it stands this tick
      const px: number[] = new Array(40 * 40).fill(0);
      for (let cell = 0; cell < BOX * BOX; cell++) {
        const tile = grid[cell] === SPACE ? undefined : vram.get(grid[cell]!);
        if (!tile) continue;
        const ox = (cell % BOX) * 8;
        const oy = Math.floor(cell / BOX) * 8;
        for (let y = 0; y < 8; y++) {
          const lo = tile[y * 2]!;
          const hi = tile[y * 2 + 1]!;
          for (let x = 0; x < 8; x++) {
            const b = 7 - x;
            px[(oy + y) * 40 + ox + x] = ((hi >> b) & 1) * 2 + ((lo >> b) & 1);
          }
        }
      }
      const key = px.join("");
      let index = frameKeys.get(key);
      if (index === undefined) {
        index = frameImages.length;
        frameKeys.set(key, index);
        frameImages.push(px);
      }
      script.ticks.push(index);
      if (script.thunderbolt === tick) {
        const flashed = px.map((v) => (v === 3 ? 3 : 0));
        const fkey = flashed.join("");
        let fi = frameKeys.get(fkey);
        if (fi === undefined) {
          fi = frameImages.length;
          frameKeys.set(fkey, fi);
          frameImages.push(flashed);
        }
        script.flash = fi;
      }
      // CheckPikaPicAnimTimer: down by one; done at 0
      timer = (timer - 1) & 0xffff;
      if (timer === 0) break;
    }
    scripts.push(script);
  }

  // TextBoxBorder's tiles: $79 corner, $7a top, $7b corner, $7c side,
  // $7d corner, $7e corner -- TextBoxGraphics is tiles $60-$7f
  const tb = ctx.symbol("TextBoxGraphics");
  const borderTile = (code: number): number[] => rom.bytes(tb.bank, tb.address + (code - 0x60) * 16, 16);
  const ring: (number[] | null)[] = [];
  const OUT = BOX + 2;
  for (let ty = 0; ty < OUT; ty++) {
    for (let tx = 0; tx < OUT; tx++) {
      const top = ty === 0;
      const bottom = ty === OUT - 1;
      const left = tx === 0;
      const right = tx === OUT - 1;
      let code = -1;
      if (top) code = left ? 0x79 : right ? 0x7b : 0x7a;
      else if (bottom) code = left ? 0x7d : right ? 0x7e : 0x7a;
      else if (left || right) code = 0x7c;
      ring.push(code >= 0 ? borderTile(code) : null);
    }
  }
  frameImages.forEach((px, i) => {
    // re-encode as 2bpp, tile by tile, so decode2bpp makes the image the
    // rest of gfx uses: the border's tiles round the face's
    const raw: number[] = [];
    for (let ty = 0; ty < OUT; ty++) {
      for (let tx = 0; tx < OUT; tx++) {
        const edge = ring[ty * OUT + tx];
        if (edge) {
          raw.push(...edge);
          continue;
        }
        for (let y = 0; y < 8; y++) {
          let lo = 0;
          let hi = 0;
          for (let x = 0; x < 8; x++) {
            const v = px[((ty - 1) * 8 + y) * 40 + (tx - 1) * 8 + x]!;
            lo |= (v & 1) << (7 - x);
            hi |= ((v >> 1) & 1) << (7 - x);
          }
          raw.push(lo, hi);
        }
      }
    }
    gfx.add(`pikapic/f${String(i).padStart(3, "0")}`, decode2bpp(raw, OUT * 8, OUT * 8));
  });
  return { frames: frameImages.length, scripts };
}
