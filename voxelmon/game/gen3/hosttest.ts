// pocket-voxel host entry for the gen3 (FireRed) port (GPLv3 + additional terms; see LICENSE.md).
//
// The host test card: one deterministic scene per frame index, drawn through
// the love.graphics stand-in (platform/graphics.ts) into a draw list, so the
// 3DS renderer (crates/pocketvoxel-3ds/src/gen3/g3_render.c) and the desktop
// rasteriser (platform/rasterize.ts) can be compared frame for frame:
// rectangles and blend modes, cache images (decoded by the guest and by the
// host), a canvas, scissor, a rotated/scaled image, repeat wrap (power of two
// and not), and the TEV / CPU effects, with the frame number in 7-segment.

import { G, type Shader } from "./platform/graphics.ts";
import { newImageData, type Canvas, type Image } from "./platform/image.ts";

const ROOT = "data/generated/gba/";

/** The cache files the card reads (the 3DS needs them on the card). */
export const HOSTTEST_FILES = [
  "intro/title_logo.png", "intro/oak.png", "intro/pikachu_body.png", "intro/nidoran_f.png",
  "intro/intro_scene2_gengar.png", "intro/intro_star.png", "region_map/navel_rock_patch.png",
];

/** The frame the 3DS photographs (and the desktop renders) for the comparison. */
export const HOSTTEST_SHOT_FRAME = 90;

// 7-segment: a b c d e f g
const SEGS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];

function digit(x: number, y: number, d: number): void {
  const m = SEGS[d]!;
  const w = 8, h = 14, t = 2, hh = 6;
  const r = (bit: number, rx: number, ry: number, rw: number, rh: number): void => {
    if (m & (1 << bit)) G.rectangle("fill", x + rx, y + ry, rw, rh);
  };
  r(0, t, 0, w - 2 * t, t);           // a
  r(1, w - t, t, t, hh);              // b
  r(2, w - t, h - t - hh, t, hh);     // c
  r(3, t, h - t, w - 2 * t, t);       // d
  r(4, 0, h - t - hh, t, hh);         // e
  r(5, 0, t, t, hh);                  // f
  r(6, t, (h - t) / 2, w - 2 * t, t); // g
}

export class HostTest {
  readonly logo: Image;
  readonly oak: Image;
  readonly pika: Image;
  readonly nido: Image;
  readonly gengar: Image;
  readonly star: Image;
  readonly patch: Image;
  readonly cv: Canvas;
  private sh: Record<string, Shader> = {};

  constructor() {
    // decoded by the guest (newImageData -> texUpload) and by the host (texFromCache)
    this.logo = G.newImage(newImageData(ROOT + "intro/title_logo.png"));
    this.oak = G.newImage(ROOT + "intro/oak.png");
    this.pika = G.newImage(ROOT + "intro/pikachu_body.png");
    this.nido = G.newImage(ROOT + "intro/nidoran_f.png");
    this.gengar = G.newImage(newImageData(ROOT + "intro/intro_scene2_gengar.png"));
    this.star = G.newImage(newImageData(ROOT + "intro/intro_star.png"));
    this.star.setWrap("repeat");
    this.patch = G.newImage(newImageData(ROOT + "region_map/navel_rock_patch.png"));
    this.patch.setWrap("repeat");
    this.cv = G.newCanvas(48, 48);
  }

  private shader(name: string, key = name): Shader {
    return (this.sh[key] ??= G.newShader(name));
  }

  /** A tile: the nidoran at a quarter (16x16) through `name`'s effect. */
  private tile(x: number, y: number, name: string | undefined, u: Record<string, unknown> = {},
    col: [number, number, number, number] = [1, 1, 1, 1], key?: string): void {
    if (name) {
      const s = this.shader(name, key ?? `${name}:${x}:${y}`);
      for (const [k, v] of Object.entries(u)) s.send(k, v);
      G.setShader(s);
    }
    G.setColor(col[0], col[1], col[2], col[3]);
    G.draw(this.nido, x, y, 0, 0.25);
    G.setShader();
    G.setColor(1, 1, 1, 1);
  }

  frame(f: number): void {
    G.beginFrame();
    G.clear(0.1, 0.15, 0.3, 1);

    // ---- top left: rectangles and blend modes
    G.setColor(0.9, 0.2, 0.2, 1);
    G.rectangle("fill", 4, 4, 50, 30);
    G.setColor(0.2, 0.9, 0.3, 0.5);
    G.rectangle("fill", 30, 16, 50, 30);
    G.setBlendMode("add");
    G.setColor(0, 0, 1, 1);
    G.rectangle("fill", 56, 28, 50, 30);
    G.setBlendMode("multiply", "premultiplied");
    G.setColor(1, 0.6, 0.6, 1);
    G.rectangle("fill", 10, 52, 100, 20);
    G.setBlendMode("subtract");
    G.setColor(0.5, 0.5, 0, 1);
    G.rectangle("fill", 84, 4, 26, 20);
    G.setBlendMode("alpha");
    G.setColor(1, 1, 0, 1);
    G.setLineWidth(1);
    G.rectangle("line", 1.5, 1.5, 115, 75);
    G.setColor(1, 1, 1, 1);

    // ---- top right: the title logo at half size, a gba_fx band sweeping it
    const band = this.shader("gba_fx", "band");
    band.send("fadeY", 0); band.send("fadeColor", [0, 0, 0]); band.send("gray", 0); band.send("bldy", 0);
    band.send("mode", 0); band.send("k", 1); band.send("bandOn", 1); band.send("bandY", (f * 2) % 100 - 10);
    band.send("winOn", 0);
    G.setShader(band);
    G.draw(this.logo, 120, 0, 0, 0.5, 0.5);
    G.setShader();

    // ---- middle: canvas, scissor, rotation, effects
    G.setCanvas(this.cv);
    G.clear(0, 0, 0, 0);
    G.push();
    G.translate(24, 24);
    G.rotate(f * 0.05);
    G.setColor(1, 0.8, 0.2, 1);
    G.rectangle("fill", -14, -14, 28, 28);
    G.pop();
    G.setColor(0.2, 0.6, 1, 0.7);
    G.circle("fill", 24 + 14 * Math.cos(f * 0.1), 24, 8);
    G.setCanvas();
    G.setColor(1, 1, 1, 1);
    G.draw(this.cv, 2, 80);

    G.setScissor(54, 80, 40, 48);
    G.draw(this.oak, 34 + (f % 40), 76);
    G.setScissor();
    G.setColor(1, 1, 1, 0.5);
    G.rectangle("line", 53.5, 79.5, 41, 49);
    G.setColor(1, 1, 1, 1);

    G.draw(this.oak, 114, 104, f * 0.03, 0.5, 0.5, 32, 48);

    G.setShader(this.shader("silhouette"));
    G.setColor(0.05, 0.05, 0.1, 1);
    G.draw(this.pika, 136, 80, 0, 0.75);
    G.setShader();
    G.setColor(1, 1, 1, 1);

    const b5 = this.shader("blend5");
    b5.send("coeff", f % 17);
    b5.send("target", [31, 31, 31]);
    G.setShader(b5);
    G.draw(this.nido, 160, 80, 0, 0.75);
    G.setShader();

    const fx = this.shader("gba_fx", "fade");
    fx.send("fadeY", Math.floor(8 + 8 * Math.sin(f * 0.08))); fx.send("fadeColor", [0, 0, 0]); fx.send("gray", 0);
    fx.send("bldy", 0); fx.send("mode", 0); fx.send("k", 1); fx.send("bandOn", 0); fx.send("winOn", 0);
    G.setShader(fx);
    G.draw(this.gengar, 208, 84, 0, 0.5);
    G.setShader();

    // ---- row A: the frame number, then effect tiles
    G.setColor(1, 1, 1, 1);
    const s = String(f % 100000).padStart(5, "0");
    for (let i = 0; i < 5; i++) digit(2 + i * 10, 129, s.charCodeAt(i) - 48);
    let x = 56;
    const y = 128;
    this.tile(x, y, undefined); x += 18;
    this.tile(x, y, "gray5"); x += 18;
    this.tile(x, y, "gray5_pre", {}, [1, 0.8, 0.8, 1]); x += 18;
    this.tile(x, y, "gray_luma"); x += 18;
    this.tile(x, y, "mix_target", { target: [1, 0, 0], coeff: 0.5 }); x += 18;
    this.tile(x, y, "screen_fx", { effectType: 1, coeff: 0, targetColor: [0, 0, 0] }); x += 18;
    this.tile(x, y, "screen_fx", { effectType: 4, coeff: 1, targetColor: [0, 0, 0] }); x += 18;
    this.tile(x, y, "tint_alpha", {}, [0.2, 0.8, 1, 1]); x += 18;
    this.tile(x, y, "affine_color", { m: 1.5, off: [-0.1, 0, 0.2] }); x += 18;
    this.tile(x, y, "mosaic", { texSize: [64, 64], block: 8 });

    // ---- row B: repeat wrap (not a power of two; a power of two, scrolling), more tiles
    G.draw(this.patch, G.newQuad(0, 0, 24 * 4.5, 16, 24, 16), 2, 147, 0, 0.625);
    G.draw(this.star, G.newQuad(f % 16, 0, 64, 16, 16, 16), 74, 147, 0, 0.625);
    x = 120;
    const yb = 144;
    this.tile(x, yb, "level_flash", { k1: [0, 0, 0], k2: [1, 1, 1], target: [1, 0, 0], coeff: 1 }); x += 18;
    this.tile(x, yb, "region_map", { tintOn: 1, tone: [255, 200, 120], fadeY: 0, fx: 0, amt: 0 }); x += 18;
    this.tile(x, yb, "solid_mask", {}, [1, 0, 1, 1]); x += 18;
    this.tile(x, yb, "mask_overlay", { fx: [0, 1, 0], amount: 0.8 }); x += 18;
    this.tile(x, yb, "blend5_pre", { coeff: 8, target: [31, 0, 0] }, [0.5, 0.5, 1, 1]); x += 18;
    this.tile(x, yb, "gba_fx", { fadeY: 0, fadeColor: [0, 0, 0], gray: 1, bldy: 8, mode: 0, k: 1, bandOn: 0, winOn: 0 }); x += 18;
    this.tile(x, yb, "screen_fx", { effectType: 5, coeff: 0.6, targetColor: [0, 0, 1] });
    G.endFrame();
  }
}
