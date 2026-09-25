#!/usr/bin/env python3
"""Turn bannertool's flat banner into a scene with a real cube in it.

    python3 tools/3ds_banner3d.py IN.bnr OUT.cgfx

A 3DS banner is a CGFX 3D scene. bannertool builds every banner from one
template: a single textured quad. This reads that banner back, decompresses
the CGFX inside it, and replaces the quad's four vertices with twenty-eight
-- the title card (the top of the texture) and a tilted cube beneath it,
each of the cube's faces mapped to one of three shaded patches the art
paints into the texture's unused corner. bannertool then packs the result
with `-ci`, which it round-trips byte for byte.

Everything in the file is pointed to by self-relative offsets, so the new
buffers are simply appended and the handful of fields that name the old
ones are repointed: the vertex buffer's size and data pointer, the index
stream's count and data pointer, the bounding box, the IMAG block size and
the file size. Nothing moves.

The layout this edits is the template's, and it is asserted before a byte
is written: a different bannertool would need a different map.
"""
import math
import struct
import sys

# --- the template's map (bannertool 1.2.0), asserted below -----------------
VB_OBJ = 0xE34          # interleaved vertex buffer object
VB_SIZE = VB_OBJ + 0x14
VB_DATA = VB_OBJ + 0x18
VB_STRIDE = VB_OBJ + 0x24
IS_OBJ = 0xE04          # index stream object
IS_COUNT = IS_OBJ + 0x0C
IS_DATA = IS_OBJ + 0x10
OBB = 0xD94             # flags, center xyz, orientation 3x3, size xyz
CULL_ENUM = 0x9C0       # material rasterization: GfxFaceCulling (1 = back)
CULL_CMD = 0x9C8        # ...and the PICA command it becomes: GPUREG_FACECULLING_MODE value
IMAG = 0x14F8           # 'IMAG', u32 size (header included), then the data the pointers land in
CGFX_SIZE = 0x0C

# --- geometry, in the template's world units --------------------------------
# The template quad is 26 wide by 13 tall, x -13..13, y -7.5..5.5, and maps
# the whole texture. The card keeps the top CARD_ROWS of the 128-row texture
# at the same scale; the cube sits under it, mapped to three patches painted
# at the bottom-left of the texture by tools/3ds_art.py (PATCH_*).
TEX_H = 128
CARD_ROWS = 62
QUAD_TOP, QUAD_BOTTOM, QUAD_HALF_W = 5.5, -7.5, 13.0
UNITS_PER_ROW = (QUAD_TOP - QUAD_BOTTOM) / TEX_H
CUBE_CENTER = (0.0, -4.3, 0.0)
CUBE_HALF = 2.3
CUBE_YAW, CUBE_PITCH = math.radians(34), math.radians(-22)
# u ranges of the three 16px patches at texture rows 112..128, inset a bit
PATCH_V = (2 / 128, 14 / 128)
PATCH_U = {"light": (2 / 256, 14 / 256), "mid": (18 / 256, 30 / 256), "dark": (34 / 256, 46 / 256)}


def rot(v):
    x, y, z = v
    x, z = x * math.cos(CUBE_YAW) - z * math.sin(CUBE_YAW), x * math.sin(CUBE_YAW) + z * math.cos(CUBE_YAW)
    y, z = y * math.cos(CUBE_PITCH) - z * math.sin(CUBE_PITCH), y * math.sin(CUBE_PITCH) + z * math.cos(CUBE_PITCH)
    return x + CUBE_CENTER[0], y + CUBE_CENTER[1], z + CUBE_CENTER[2]


def build_geometry():
    """(vertices as (x,y,z,u,v), u8 indices). Counter-clockwise from outside."""
    verts, idx = [], []
    # the card: top CARD_ROWS rows of the texture, v=1 at the top edge
    card_bottom = QUAD_TOP - CARD_ROWS * UNITS_PER_ROW
    v_bottom = 1.0 - CARD_ROWS / TEX_H
    base = len(verts)
    verts += [(-QUAD_HALF_W, card_bottom, 0.0, 0.0, v_bottom),
              (QUAD_HALF_W, card_bottom, 0.0, 1.0, v_bottom),
              (-QUAD_HALF_W, QUAD_TOP, 0.0, 0.0, 1.0),
              (QUAD_HALF_W, QUAD_TOP, 0.0, 1.0, 1.0)]
    idx += [base, base + 1, base + 2, base + 1, base + 3, base + 2]
    # the cube: six faces, each its own four vertices so each can own a patch
    h = CUBE_HALF
    faces = [  # (corners CCW seen from outside, shade)
        ([(-h, h, -h), (-h, h, h), (h, h, h), (h, h, -h)], "light"),   # +y top
        ([(-h, -h, h), (h, -h, h), (h, h, h), (-h, h, h)], "mid"),     # +z front
        ([(h, -h, h), (h, -h, -h), (h, h, -h), (h, h, h)], "dark"),    # +x right
        ([(h, -h, -h), (-h, -h, -h), (-h, h, -h), (h, h, -h)], "dark"),  # -z back
        ([(-h, -h, -h), (-h, -h, h), (-h, h, h), (-h, h, -h)], "dark"),  # -x left
        ([(-h, -h, -h), (h, -h, -h), (h, -h, h), (-h, -h, h)], "dark"),  # -y bottom
    ]
    for corners, shade in faces:
        u0, u1 = PATCH_U[shade]
        v0, v1 = PATCH_V
        uvs = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
        base = len(verts)
        for c, (u, v) in zip(corners, uvs):
            x, y, z = rot(c)
            verts.append((x, y, z, u, v))
        idx += [base, base + 1, base + 2, base, base + 2, base + 3]
    return verts, idx


def lz11(data):
    assert data[0] == 0x11, "not LZ11"
    size = data[1] | data[2] << 8 | data[3] << 16
    out = bytearray()
    i = 4
    while len(out) < size:
        flags = data[i]
        i += 1
        for bit in range(7, -1, -1):
            if len(out) >= size:
                break
            if not (flags >> bit) & 1:
                out.append(data[i])
                i += 1
                continue
            b1 = data[i]
            ind = b1 >> 4
            if ind == 0:
                ln = ((b1 << 4) | (data[i + 1] >> 4)) + 0x11
                disp = (((data[i + 1] & 0xF) << 8) | data[i + 2]) + 1
                i += 3
            elif ind == 1:
                ln = (((b1 & 0xF) << 12) | (data[i + 1] << 4) | (data[i + 2] >> 4)) + 0x111
                disp = (((data[i + 2] & 0xF) << 8) | data[i + 3]) + 1
                i += 4
            else:
                ln = ind + 1
                disp = (((b1 & 0xF) << 8) | data[i + 1]) + 1
                i += 2
            for _ in range(ln):
                out.append(out[-disp])
    return bytes(out)


def main(bnr_path, out_path):
    bnr = open(bnr_path, "rb").read()
    assert bnr[:4] == b"CBMD", "not a banner"
    cg_off = struct.unpack_from("<I", bnr, 8)[0]
    cwav = struct.unpack_from("<I", bnr, 0x84)[0]
    g = bytearray(lz11(bnr[cg_off:cwav]))
    u32 = lambda o: struct.unpack_from("<I", g, o)[0]
    i32 = lambda o: struct.unpack_from("<i", g, o)[0]

    # the template, or refuse
    assert g[:4] == b"CGFX" and u32(CGFX_SIZE) == len(g), "size field disagrees"
    assert u32(VB_OBJ) == 0x40000002 and u32(VB_STRIDE) == 20 and u32(VB_SIZE) == 80, "unexpected vertex buffer"
    assert u32(IS_COUNT) == 6 and u32(IS_OBJ + 4) == 0x1401, "unexpected index stream"
    assert g[IMAG:IMAG + 4] == b"IMAG" and IMAG + u32(IMAG + 4) == len(g), "IMAG is not the tail"
    assert u32(CULL_ENUM) == 1 and u32(CULL_CMD) == 2 and u32(CULL_CMD + 4) == 0x10040, "unexpected culling"
    old_vdata = VB_DATA + i32(VB_DATA)
    assert struct.unpack_from("<f", g, old_vdata)[0] == -13.0, "vertex data not where expected"

    verts, idx = build_geometry()
    assert len(verts) < 256, "u8 indices"
    ib = bytes(idx)
    ib += b"\0" * (-len(ib) % 4)
    vb = b"".join(struct.pack("<5f", *v) for v in verts)

    # append: index data, then vertex data, both 4-aligned at the tail
    while len(g) % 4:
        g.append(0)
    new_idx = len(g)
    g += ib
    new_vtx = len(g)
    g += vb
    grown = len(g) - u32(CGFX_SIZE)

    def set_u32(o, v): struct.pack_into("<I", g, o, v)
    def set_i32(o, v): struct.pack_into("<i", g, o, v)
    set_u32(VB_SIZE, len(vb))
    set_i32(VB_DATA, new_vtx - VB_DATA)
    set_u32(IS_COUNT, len(idx))
    set_i32(IS_DATA, new_idx - IS_DATA)
    set_u32(IMAG + 4, u32(IMAG + 4) + grown)
    set_u32(CGFX_SIZE, len(g))

    # The template culls back faces. The cube's faces wind counter-clockwise
    # from outside, but which way the HOME menu's camera faces this scene is
    # the viewer's business, not the file's, and the depth test is on
    # (LESS), so the faces sort themselves: draw both sides and be sure.
    set_u32(CULL_ENUM, 3)   # Never
    set_u32(CULL_CMD, 0)    # GPU_CULL_NONE

    # bounding box: center, then size, over everything
    xs = [v[0] for v in verts]; ys = [v[1] for v in verts]; zs = [v[2] for v in verts]
    cx, cy, cz = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2
    struct.pack_into("<3f", g, OBB + 4, cx, cy, cz)
    struct.pack_into("<3f", g, OBB + 4 + 12 + 36, max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))

    open(out_path, "wb").write(bytes(g))
    print(f"banner3d: {len(verts)} vertices, {len(idx)} indices, cgfx {len(g)} bytes "
          f"(+{grown}), box centre ({cx:.2f},{cy:.2f},{cz:.2f}) size "
          f"({max(xs)-min(xs):.1f},{max(ys)-min(ys):.1f},{max(zs)-min(zs):.1f})")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
