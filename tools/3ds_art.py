#!/usr/bin/env python3
"""Generate the 3DS icon and banner for the CIA build.

Everything here is drawn from scratch by this file: the letterforms are
authored below as bitmaps and the cube is a real 8-vertex projection with a
line rasteriser. Nothing is sampled from the ROM, from the cooked art, or
from anyone else's work -- the installed title's shelf presence has to be
ours, and the game's own font is the cartridge's.

    python3 tools/3ds_art.py OUTDIR

writes OUTDIR/icon.png (48x48) and OUTDIR/banner.png (256x128).
"""
import math
import os
import struct
import sys
import zlib

# --- png -------------------------------------------------------------------


def write_png(path, w, h, rgb):
    """rgb: bytearray of w*h*3."""
    raw = b"".join(b"\x00" + bytes(rgb[y * w * 3:(y + 1) * w * 3]) for y in range(h))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


class Canvas:
    def __init__(self, w, h, bg=(8, 8, 12)):
        self.w, self.h = w, h
        self.px = bytearray(bytes(bg) * (w * h))

    def put(self, x, y, rgb, a=1.0):
        if not (0 <= x < self.w and 0 <= y < self.h) or a <= 0:
            return
        i = (y * self.w + x) * 3
        if a >= 1.0:
            self.px[i:i + 3] = bytes(rgb)
            return
        for k in range(3):
            self.px[i + k] = int(self.px[i + k] * (1 - a) + rgb[k] * a)

    def line(self, x0, y0, x1, y1, rgb, width=1.0):
        """A plain distance-to-segment line, so it comes out smooth at any
        angle -- a cube drawn with Bresenham reads as a staircase at this
        size, which is the opposite of the clean wireframe we are after."""
        lo_x = max(0, int(min(x0, x1) - width - 2))
        hi_x = min(self.w - 1, int(max(x0, x1) + width + 2))
        lo_y = max(0, int(min(y0, y1) - width - 2))
        hi_y = min(self.h - 1, int(max(y0, y1) + width + 2))
        dx, dy = x1 - x0, y1 - y0
        ll = dx * dx + dy * dy
        for y in range(lo_y, hi_y + 1):
            for x in range(lo_x, hi_x + 1):
                t = 0.0 if ll == 0 else max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / ll))
                d = math.hypot(x - (x0 + dx * t), y - (y0 + dy * t))
                a = max(0.0, min(1.0, (width - d) * 0.9 + 0.5))
                if a > 0:
                    self.put(x, y, rgb, a)


# --- letterforms -----------------------------------------------------------
# 5x7, authored here. Only the glyphs the banner actually says.

GLYPHS = {
    "P": ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
    "O": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "C": [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
    "K": ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
    "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "V": ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
    "X": ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
    "L": ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
    "D": ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
    "R": ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
    "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
    " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
}
GW, GH = 5, 7


def text_width(s, scale, gap):
    return len(s) * GW * scale + (len(s) - 1) * gap


def draw_text(c, s, x, y, scale, gap, rgb):
    for ch in s:
        rows = GLYPHS.get(ch, GLYPHS[" "])
        for ry, row in enumerate(rows):
            for rx, cell in enumerate(row):
                if cell != "#":
                    continue
                for j in range(scale):
                    for i in range(scale):
                        c.put(x + rx * scale + i, y + ry * scale + j, rgb)
        x += GW * scale + gap


# --- the cube --------------------------------------------------------------

CUBE_V = [(-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
          (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]
CUBE_E = [(0, 1), (1, 2), (2, 3), (3, 0),
          (4, 5), (5, 6), (6, 7), (7, 4),
          (0, 4), (1, 5), (2, 6), (3, 7)]


def draw_cube(c, cx, cy, size, yaw, pitch, rgb, width=1.4, fade_back=True):
    """A real projection, not an isometric fake: the far edges come out
    thinner and dimmer, which is the whole reason it reads as a solid shape
    standing in space rather than as a flat hexagon of lines."""
    pts, depth = [], []
    for vx, vy, vz in CUBE_V:
        x = vx * math.cos(yaw) - vz * math.sin(yaw)
        z = vx * math.sin(yaw) + vz * math.cos(yaw)
        y = vy * math.cos(pitch) - z * math.sin(pitch)
        z = vy * math.sin(pitch) + z * math.cos(pitch)
        d = 4.2
        k = d / (d + z)
        pts.append((cx + x * size * k, cy + y * size * k))
        depth.append(z)
    order = sorted(range(len(CUBE_E)), key=lambda i: -(depth[CUBE_E[i][0]] + depth[CUBE_E[i][1]]))
    for i in order:
        a, b = CUBE_E[i]
        near = -(depth[a] + depth[b]) / 2.0
        t = (near + 1.6) / 3.2
        if fade_back:
            shade = tuple(int(v * (0.38 + 0.62 * max(0.0, min(1.0, t)))) for v in rgb)
            w = width * (0.72 + 0.4 * max(0.0, min(1.0, t)))
        else:
            shade, w = rgb, width
        c.line(pts[a][0], pts[a][1], pts[b][0], pts[b][1], shade, w)
    return pts


RED = (228, 42, 46)
DIM_RED = (96, 20, 24)
WHITE = (238, 238, 244)


def make_banner(path):
    c = Canvas(256, 128)
    # a hairline grid, so the cube has a floor to stand on
    for gy in range(0, 128, 16):
        c.line(0, gy, 255, gy, (20, 20, 28), 0.6)
    for gx in range(0, 256, 16):
        c.line(gx, 0, gx, 127, (20, 20, 28), 0.6)

    top, bottom = "POCKET VOXEL", "3D RED"
    s1, g1 = 3, 3
    x1 = (256 - text_width(top, s1, g1)) // 2
    draw_text(c, top, x1, 10, s1, g1, WHITE)
    s2, g2 = 3, 3
    x2 = (256 - text_width(bottom, s2, g2)) // 2
    draw_text(c, bottom, x2, 36, s2, g2, RED)

    # The cube, under the words. A ghost of it one step back in the spin
    # says "this turns" -- the banner itself cannot move, so the motion has
    # to be implied in the one frame we get.
    draw_cube(c, 128, 90, 26, 0.55, 0.42, DIM_RED, width=1.0, fade_back=False)
    draw_cube(c, 128, 90, 26, 0.86, 0.42, RED, width=1.5)
    write_png(path, c.w, c.h, c.px)


def make_icon(path):
    c = Canvas(48, 48)
    draw_cube(c, 24, 25, 15, 0.86, 0.42, RED, width=1.7)
    write_png(path, c.w, c.h, c.px)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    make_banner(os.path.join(out, "banner.png"))
    make_icon(os.path.join(out, "icon.png"))
    print(f"wrote {out}/banner.png (256x128) and {out}/icon.png (48x48)")
