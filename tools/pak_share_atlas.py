#!/usr/bin/env python3
"""Hoist the atlas pages every map shares into one common blob.

428 of the ~470 atlas pages in a cooked map -- the sprites, the font, the UI,
the battle furniture -- are byte-identical in all 219 paks. That is about
1.06 MB of the 1.63 MB an average map spends on atlas texels, re-read off the
SD card on every single map change.

This rewrites the cooked paks in place-ish (to an output directory) so those
pages live once in `common.vxat`, and each pak's ATLS directory points at it
with pak.rs's ATLAS_SHARED_BIT. The page DIRECTORY is untouched -- same pages,
same order, same indices -- so nothing downstream of Pak.atlases can tell the
difference; only the texel bytes move.

It is a byte transformation over already-cooked paks, deliberately not a
cooker change: no ROM, no colour packs, no re-deriving geometry, and the
result is checkable against the input page for page.

    python3 tools/pak_share_atlas.py dist/voxelmon/paks out/paks
    python3 tools/pak_share_atlas.py dist/voxelmon/paks out/paks --verify
"""
import hashlib
import os
import struct
import sys

HDR = 16
ENTRY = 16
ALIGN = 16
SHARED_BIT = 1 << 31
# A page must appear in at least this many maps to be worth hoisting. Two is
# enough to break even on bytes; the real population is "all of them or one".
MIN_MAPS = 2


def read_sections(d):
    """[(tag, off, len, count)] in file order."""
    n = struct.unpack_from("<H", d, 6)[0]
    out = []
    for s in range(n):
        e = HDR + s * ENTRY
        tag = d[e:e + 4]
        off, ln, cnt = struct.unpack_from("<III", d, e + 4)
        out.append((tag, off, ln, cnt))
    return out


def atlas_pages(d, secs):
    """[(w, h, kind, frames, off, len, total, sha)] for each page."""
    off, ln, _ = next((o, l, c) for t, o, l, c in secs if t == b"ATLS")
    sect = d[off:off + ln]
    n = struct.unpack_from("<H", sect, 0)[0]
    pages = []
    p = 2
    for _ in range(n):
        w, h, kind, frames = struct.unpack_from("<HHHH", sect, p)
        o, l = struct.unpack_from("<II", sect, p + 8)
        p += ENTRY
        total = l * frames
        blob = sect[o:o + total]
        pages.append((w, h, kind, frames, o, l, total, hashlib.sha1(blob).digest(), blob))
    return sect, n, pages


def survey(paths):
    """sha -> (bytes, number of maps carrying it)."""
    seen = {}
    for path in paths:
        d = open(path, "rb").read()
        _, _, pages = atlas_pages(d, read_sections(d))
        for pg in {p[7]: p for p in pages}.values():   # once per map
            sha = pg[7]
            n, cnt = seen.get(sha, (pg[6], 0))
            seen[sha] = (n, cnt + 1)
    return seen


def build_common(paths, seen):
    """The shared blob, plus sha -> offset within it."""
    shared = {s for s, (_, c) in seen.items() if c >= MIN_MAPS}
    blob = bytearray()
    at = {}
    for path in paths:                     # deterministic: file order, page order
        d = open(path, "rb").read()
        _, _, pages = atlas_pages(d, read_sections(d))
        for pg in pages:
            sha = pg[7]
            if sha not in shared or sha in at:
                continue
            if len(blob) % ALIGN:
                blob.extend(b"\0" * (ALIGN - len(blob) % ALIGN))
            at[sha] = len(blob)
            blob.extend(pg[8])
    if len(blob) % ALIGN:
        blob.extend(b"\0" * (ALIGN - len(blob) % ALIGN))
    return bytes(blob), at


def repack(path, at, out_path):
    """Rewrite one pak with its shared pages hoisted out of ATLS."""
    d = open(path, "rb").read()
    secs = read_sections(d)
    a_off, a_len, a_cnt = next((o, l, c) for t, o, l, c in secs if t == b"ATLS")
    _, n, pages = atlas_pages(d, secs)

    # New ATLS: same directory, texels only for pages staying behind.
    dir_len = 2 + n * ENTRY
    body = bytearray()
    new_dir = bytearray(struct.pack("<H", n))
    local_at = {}
    for (w, h, kind, frames, _o, l, total, sha, blob) in pages:
        if sha in at:
            off = at[sha] | SHARED_BIT
        elif sha in local_at:
            off = local_at[sha]                      # dedupe within the map too
        else:
            pad = (-(dir_len + len(body))) % ALIGN
            body.extend(b"\0" * pad)
            off = dir_len + len(body)
            local_at[sha] = off
            body.extend(blob)
        new_dir.extend(struct.pack("<HHHHII", w, h, kind, frames, off, l))
    new_atls = bytes(new_dir) + bytes(body)

    # ATLS is the last section, so only its own length and the file total move.
    assert a_off + a_len == len(d), "ATLS is not last; repack needs a rewrite"
    out = bytearray(d[:a_off])
    out.extend(new_atls)
    struct.pack_into("<I", out, 8, len(out))          # header total_len
    for i, (tag, off, ln, cnt) in enumerate(secs):
        if tag == b"ATLS":
            struct.pack_into("<I", out, HDR + i * ENTRY + 8, len(new_atls))
    open(out_path, "wb").write(bytes(out))
    return len(d), len(out)


def verify(src, dst, blob):
    """Every page's texels must come back byte-identical."""
    a = open(src, "rb").read()
    b = open(dst, "rb").read()
    _, na, pa = atlas_pages(a, read_sections(a))
    sect_b, nb, _ = atlas_pages(b, read_sections(b))
    if na != nb:
        return f"page count {na} -> {nb}"
    # Re-resolve dst's pages the way pak.rs does, against the shared blob.
    p = 2
    for i in range(nb):
        w, h, kind, frames = struct.unpack_from("<HHHH", sect_b, p)
        o, l = struct.unpack_from("<II", sect_b, p + 8)
        p += ENTRY
        total = l * frames
        src_blob = (blob if (o & SHARED_BIT) else sect_b)[(o & ~SHARED_BIT):(o & ~SHARED_BIT) + total]
        want = pa[i]
        if (w, h, kind, frames, l) != (want[0], want[1], want[2], want[3], want[5]):
            return f"page {i} header changed"
        if src_blob != want[8]:
            return f"page {i} texels differ"
    # Nothing before ATLS may have moved. Two fields are allowed to differ,
    # and only these: the header's total_len, and ATLS's own length in the
    # section table. Blank both out and the rest must match byte for byte --
    # every other section's offset, length and payload included.
    secs_a = read_sections(a)
    a_off = next(o for t, o, l, c in secs_a if t == b"ATLS")
    ha, hb = bytearray(a[:a_off]), bytearray(b[:a_off])
    for h in (ha, hb):
        struct.pack_into("<I", h, 8, 0)                       # total_len
        for i, (tag, _o, _l, _c) in enumerate(secs_a):
            if tag == b"ATLS":
                struct.pack_into("<I", h, HDR + i * ENTRY + 8, 0)   # ATLS len
    if ha != hb:
        return "a byte before ATLS changed that should not have"
    if struct.unpack_from("<I", b, 8)[0] != len(b):
        return "header total_len disagrees with the file"
    a_len_b = next(l for t, o, l, c in read_sections(b) if t == b"ATLS")
    if a_off + a_len_b != len(b):
        return "ATLS length disagrees with the file"
    return None


def main():
    src_dir, out_dir = sys.argv[1], sys.argv[2]
    do_verify = "--verify" in sys.argv
    paths = sorted(
        os.path.join(src_dir, f) for f in os.listdir(src_dir) if f.endswith(".vxpak")
    )
    if not paths:
        sys.exit(f"no .vxpak under {src_dir}")
    os.makedirs(out_dir, exist_ok=True)

    print(f"surveying {len(paths)} paks...")
    seen = survey(paths)
    blob, at = build_common(paths, seen)
    print(f"  {len(seen)} distinct pages, {len(at)} hoisted, common.vxat = {len(blob)/1048576:.2f} MB")
    open(os.path.join(out_dir, "common.vxat"), "wb").write(blob)

    before = after = 0
    bad = 0
    for path in paths:
        out_path = os.path.join(out_dir, os.path.basename(path))
        b, a = repack(path, at, out_path)
        before += b
        after += a
        if do_verify:
            err = verify(path, out_path, blob)
            if err:
                bad += 1
                print(f"  FAIL {os.path.basename(path)}: {err}")
    print(f"\n{len(paths)} paks: {before/1048576:.0f} MB -> {after/1048576:.0f} MB"
          f" + {len(blob)/1048576:.2f} MB common"
          f"  ({100*(after+len(blob))/before:.0f}% of original)")
    if do_verify:
        print("verify: " + ("all paks byte-identical page for page" if not bad else f"{bad} FAILED"))
        sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
