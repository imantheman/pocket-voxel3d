// The gen3 platform: the love.graphics shim's draw list, rasterised.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { G } from "../voxelmon/game/gen3/platform/graphics.ts";
import { setHost } from "../voxelmon/game/gen3/platform/host.ts";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { ImageData, newImageData } from "../voxelmon/game/gen3/platform/image.ts";
import { encodePng } from "../voxelmon/import/gen3/png.ts";
import { decodePngBytes, inflateZlib } from "../voxelmon/game/gen3/platform/pngdecode.ts";
import { deflateSync } from "node:zlib";

function px(h: DesktopHost, x: number, y: number): number[] {
  const p = h.pixels(), o = (y * 240 + x) * 4;
  return [p[o]!, p[o + 1]!, p[o + 2]!, p[o + 3]!];
}

describe("gen3 platform", () => {
  const host = new DesktopHost(mkdtempSync(join(tmpdir(), "g3plat-")));
  setHost(host);

  test("rectangles, colour, alpha blend, scissor, transforms", () => {
    G.beginFrame();
    G.clear(1, 1, 1, 1);
    G.setColor(1, 0, 0, 1);
    G.rectangle("fill", 10, 10, 20, 10);
    G.setColor(0, 0, 1, 0.5);
    G.rectangle("fill", 20, 10, 20, 10);
    G.setScissor(100, 0, 5, 5);
    G.setColor(0, 1, 0, 1);
    G.rectangle("fill", 90, 0, 30, 30);
    G.setScissor();
    G.push();
    G.translate(50, 50);
    G.scale(2);
    G.setColor(0, 0, 0, 1);
    G.rectangle("fill", 0, 0, 3, 3);
    G.pop();
    G.endFrame();
    expect(px(host, 15, 15)).toEqual([255, 0, 0, 255]);
    expect(px(host, 25, 15)).toEqual([128, 0, 128, 255]); // red under 50% blue
    expect(px(host, 35, 15)).toEqual([128, 128, 255, 255]); // white under 50% blue
    expect(px(host, 102, 2)).toEqual([0, 255, 0, 255]);
    expect(px(host, 95, 2)).toEqual([255, 255, 255, 255]); // scissored out
    expect(px(host, 55, 55)).toEqual([0, 0, 0, 255]);
    expect(px(host, 56, 56)).toEqual([255, 255, 255, 255]); // 3x3 scaled 2 = 6x6 from 50
  });

  test("images, quads, flips, tint, sprite batches, canvases", () => {
    const d = new ImageData(4, 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) d.setPixel(x, y, x / 3, y / 3, 0, 1);
    const img = G.newImage(d);
    const q = G.newQuad(2, 0, 2, 2, 4, 4);
    G.beginFrame();
    G.clear(0, 0, 0, 1);
    G.setColor(1, 1, 1, 1);
    G.draw(img, 0, 0);
    G.draw(img, q, 10, 0);
    G.draw(img, 24, 0, 0, -1, 1); // flipped: drawn to the LEFT of x 24
    G.setColor(0.5, 0.5, 0.5, 1);
    G.draw(img, 30, 0);
    G.setColor(1, 1, 1, 1);
    const sb = G.newSpriteBatch(img);
    sb.add(q, 0, 0);
    sb.add(q, 2, 0);
    sb.set(2, q, -1e6, -1e6); // hidden
    G.draw(sb, 40, 0);
    const cv = G.newCanvas(8, 8);
    G.setCanvas(cv);
    G.clear(0, 1, 0, 1);
    G.setCanvas();
    G.draw(cv, 50, 0);
    G.endFrame();
    expect(px(host, 3, 0)).toEqual([255, 0, 0, 255]);
    expect(px(host, 10, 0)).toEqual([170, 0, 0, 255]); // quad x 2 -> 2/3
    expect(px(host, 23, 0)).toEqual([0, 0, 0, 255]); // flipped: x 23 shows texel 0
    expect(px(host, 20, 0)).toEqual([255, 0, 0, 255]);
    expect(px(host, 33, 3)).toEqual([128, 128, 0, 255]); // tinted half
    expect(px(host, 41, 1)).toEqual([255, 85, 0, 255]);
    expect(px(host, 43, 0)).toEqual([0, 0, 0, 255]); // hidden entry
    expect(px(host, 52, 2)).toEqual([0, 255, 0, 255]);
  });

  test("PNG decode: stored, zlib-compressed, through newImageData", () => {
    const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 37) & 255);
    const ours = decodePngBytes(encodePng(3, 2, rgba));
    expect(Array.from(ours.rgba)).toEqual(Array.from(rgba));
    const raw = new Uint8Array(1000).map((_, i) => (i * 7) % 13);
    expect(Array.from(inflateZlib(new Uint8Array(deflateSync(raw))))).toEqual(Array.from(raw));
    const d = newImageData(3, 2, "rgba8", rgba);
    expect(d.getPixel(1, 0)[0]).toBeCloseTo(rgba[4]! / 255);
  });
});
