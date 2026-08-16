#!/usr/bin/env python3
"""Rebuild a .vxpak containing only the maps you name.

CHNK is 25 MB of a 32 MB pak and it's the only section that grows with map
count; everything else (GAME, AUDI, VPAL, ATLS) is a fixed ~7.2 MB. Keeping
one map's chunks turns a 32 MB load into ~8-12 MB, and it stays flat as more
maps are cooked.

Indices are stored RELATIVE to their mesh's vert_base, so compacting the
pools only means moving bases — no renumbering.

  python3 tools/portkit/repack.py in.vxpak out.vxpak PALLET_TOWN ROUTE_1
  python3 tools/portkit/repack.py in.vxpak out.vxpak --ids 0 12
"""
import struct, sys, json, os

HDR = "<IHHII"          # magic, version, section_count, total_len, reserved
ENT = "<IIII"           # tag, offset, length, count
HDR_SIZE, ENT_SIZE = 16, 16
REC = 128               # 20 header bytes + 9 mesh ranges * 12
MESH_KINDS = 9


def tag_name(t):
    return struct.pack("<I", t).decode("ascii", "replace")


def read_pak(path):
    blob = open(path, "rb").read()
    magic, ver, count, total, _ = struct.unpack_from(HDR, blob, 0)
    assert total == len(blob), "header length disagrees with the file"
    secs = {}
    order = []
    for i in range(count):
        t, off, ln, cnt = struct.unpack_from(ENT, blob, HDR_SIZE + i * ENT_SIZE)
        secs[tag_name(t)] = (t, off, ln, cnt)
        order.append(tag_name(t))
    return blob, ver, secs, order


def parse_chnk(blob, off, ln):
    map_count, _pad = struct.unpack_from("<HH", blob, off)
    chunk_total, verts_off, verts_len, indices_off, indices_len = struct.unpack_from(
        "<IIIII", blob, off + 4)
    dirs = []
    for i in range(map_count):
        mid, first, cnt = struct.unpack_from("<III", blob, off + 32 + i * 12)
        dirs.append((mid, first, cnt))
    rec0 = off + 32 + map_count * 12
    return dict(map_count=map_count, chunk_total=chunk_total,
                verts_off=verts_off, verts_len=verts_len,
                indices_off=indices_off, indices_len=indices_len,
                dirs=dirs, rec0=rec0, base=off)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    want = sys.argv[3:]
    by_id = False
    if want and want[0] == "--ids":
        by_id, want = True, want[1:]

    blob, ver, secs, order = read_pak(src)
    c = parse_chnk(blob, secs["CHNK"][1], secs["CHNK"][2])
    print("source: %d maps, chunk_total %d, verts %d B, indices %d B"
          % (c["map_count"], c["chunk_total"], c["verts_len"], c["indices_len"]))

    # map_id -> name, from the GAME json if we can find it
    names = {}
    try:
        g = json.loads(blob[secs["GAME"][1]:secs["GAME"][1] + secs["GAME"][2]].decode("utf-8"))
        for k, v in (g.get("maps") or {}).items():
            if isinstance(v, dict) and "id" in v:
                names[int(v["id"])] = k
    except Exception:
        pass

    keep = []
    for mid, first, cnt in c["dirs"]:
        label = names.get(mid, str(mid))
        hit = (str(mid) in want) if by_id else (label in want or str(mid) in want)
        if not want or hit:
            keep.append((mid, first, cnt, label))
    if not keep:
        print("no maps matched; available:",
              ", ".join(names.get(m, str(m)) for m, _, _ in c["dirs"]))
        return 1
    print("keeping:", ", ".join("%s(#%d, %d chunks)" % (l, m, n) for m, _, n, l in keep))

    # --- compact the pools, rewriting mesh bases ---
    vpool, ipool = bytearray(), bytearray()
    new_recs = bytearray()
    new_dirs = []
    next_chunk = 0
    vbase_file = c["base"] + c["verts_off"]
    ibase_file = c["base"] + c["indices_off"]

    for mid, first, cnt, label in keep:
        new_dirs.append((mid, next_chunk, cnt))
        for ci in range(first, first + cnt):
            r = bytearray(blob[c["rec0"] + ci * REC: c["rec0"] + (ci + 1) * REC])
            for k in range(MESH_KINDS):
                o = 20 + k * 12
                vb, vc, ic, ib = struct.unpack_from("<IHHI", r, o)
                if vc == 0 and ic == 0:
                    continue
                nv = len(vpool) // 16
                vpool += blob[vbase_file + vb * 16: vbase_file + (vb + vc) * 16]
                ni = len(ipool) // 2
                ipool += blob[ibase_file + ib * 2: ibase_file + (ib + ic) * 2]
                struct.pack_into("<IHHI", r, o, nv, vc, ic, ni)
            new_recs += r
            next_chunk += 1

    while len(vpool) % 16:
        vpool += b"\0"
    while len(ipool) % 16:
        ipool += b"\0"

    dir_bytes = b"".join(struct.pack("<III", m, f, n) for m, f, n in new_dirs)
    head_len = 32 + len(dir_bytes) + len(new_recs)
    while head_len % 16:
        head_len += 1
    v_off = head_len
    i_off = v_off + len(vpool)

    chnk = bytearray()
    chnk += struct.pack("<HH", len(new_dirs), 0)
    chnk += struct.pack("<IIIII", next_chunk, v_off, len(vpool), i_off, len(ipool))
    chnk += b"\0" * 8
    chnk += dir_bytes + new_recs
    while len(chnk) < head_len:
        chnk += b"\0"
    chnk += vpool + ipool
    print("new CHNK: %d -> %d bytes" % (secs["CHNK"][2], len(chnk)))

    # --- STMP: keep only the surviving maps ---
    st_t, st_off, st_len, _ = secs["STMP"]
    sm_count, _ = struct.unpack_from("<HH", blob, st_off)
    st_total, = struct.unpack_from("<I", blob, st_off + 4)
    st_dirs = [struct.unpack_from("<III", blob, st_off + 8 + i * 12) for i in range(sm_count)]
    st_rec0 = st_off + 8 + sm_count * 12
    keep_ids = {m for m, _, _, _ in keep}
    s_recs, s_dirs, s_next = bytearray(), [], 0
    # STMP's table count must equal the map count, so every kept map needs a
    # directory entry — zero-count for the ones with no stamps.
    have = {mid: (first, cnt) for mid, first, cnt in st_dirs}
    for mid, _f, _c, _l in keep:
        first, cnt = have.get(mid, (0, 0))
        s_dirs.append((mid, s_next, cnt))
        if cnt:
            s_recs += blob[st_rec0 + first * 16: st_rec0 + (first + cnt) * 16]
        s_next += cnt
    stmp = struct.pack("<HH", len(s_dirs), 0) + struct.pack("<I", s_next)
    stmp += b"".join(struct.pack("<III", m, f, n) for m, f, n in s_dirs) + bytes(s_recs)

    # --- META carries map_count; keep it in step ---
    meta = bytearray(blob[secs["META"][1]:secs["META"][1] + secs["META"][2]])
    struct.pack_into("<I", meta, 0, len(new_dirs))

    payloads = {}
    counts = {}
    for name in order:
        t, off, ln, cnt = secs[name]
        if name == "CHNK":
            payloads[name], counts[name] = bytes(chnk), len(new_dirs)
        elif name == "STMP":
            payloads[name], counts[name] = bytes(stmp), len(s_dirs)
        elif name == "META":
            payloads[name], counts[name] = bytes(meta), cnt
        else:
            payloads[name], counts[name] = blob[off:off + ln], cnt

    table_end = HDR_SIZE + len(order) * ENT_SIZE
    out, entries, cur = bytearray(), [], table_end
    while cur % 16:
        cur += 1
    for name in order:
        p = payloads[name]
        entries.append((secs[name][0], cur, len(p), counts[name]))
        cur += len(p)
        while cur % 16:
            cur += 1

    total = entries[-1][1] + len(payloads[order[-1]])
    out += struct.pack(HDR, struct.unpack_from(HDR, blob, 0)[0], ver, len(order), total, 0)
    for e in entries:
        out += struct.pack(ENT, *e)
    for name, e in zip(order, entries):
        while len(out) < e[1]:
            out += b"\0"
        out += payloads[name]
    out = out[:total]

    open(dst, "wb").write(out)
    print("wrote %s: %.1f MB (was %.1f MB)"
          % (dst, len(out) / 1e6, len(blob) / 1e6))
    return 0


sys.exit(main())
