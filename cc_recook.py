#!/usr/bin/env python3
"""Re-cook map paks safely.

Three traps this exists to avoid, all hit for real:

  * The cook needs VOXELMON_VOXELMOD pointing at the voxel-height profile.
    Without it every map meshes FLAT and cut-tree stamps vanish entirely --
    Game Corner came out 21,493 verts instead of 31,448, and Viridian City
    lost both its cut trees. The cook only warns, on stderr, and carries on.

  * It needs VOXELMON_G1R pointing at the gen1recomp checkout for the RED++
    colour pack. Without it the pak gets no VPAL tail and every VCOL binding
    reads NONE, so the map renders in GB grayscale -- which is how 20 paks
    shipped black-and-white. Same silent stderr warning, same carry-on.

    Both live in ~/.bashrc BELOW the non-interactive early return, so a
    script-spawned shell inherits neither. Hence: set them here, explicitly.

  * `--out` rewrites gamedata.json beside the pak, so a single-map cook pins
    cookedMaps to that one map.

So: cook to a temp dir, check the result against the pak being replaced, and
install only what passes. gamedata.json is md5-checked at the end.

usage: cc_recook.py MAP [MAP...]        (or --cut-trees for the 19, --all)
       --stamps-may-drop                allow a stamp count to fall (still
                                        never to zero) -- for a deliberate
                                        change in what liftBlock lifts
"""
import hashlib, json, os, shutil, struct, subprocess, sys

ROOT = os.path.expanduser("~/pocket-voxel")
# dist/voxelmon/paks now holds atlas-repacked paks, so a fresh cook has to be
# installed into the pristine set (paks_orig) and the repack re-run over it.
PAKS = os.environ.get("CC_RECOOK_PAKS") or os.path.join(ROOT, "dist/voxelmon/paks")
TMP = "/tmp/cc_recook"
PROFILE = os.path.expanduser("~/potato_voxel")
G1R = os.path.expanduser("~/gen1recomp")
NONE = 0xFFFF


def sections(b):
    n = struct.unpack_from("<H", b, 6)[0]
    out = {}
    for i in range(n):
        t, off, ln, cnt = struct.unpack_from("<IIII", b, 16 + i * 16)
        out[struct.pack("<I", t).decode("ascii", "replace")] = (off, ln, cnt)
    return out


def bindings(b, s):
    """How many RED++ colour bindings the pak carries (0 == grayscale)."""
    if "VCOL" not in s:
        return 0
    o = s["VCOL"][0]
    _ver, nmap, npage, _fl = struct.unpack_from("<HHHH", b, o)
    rec = o + 16
    n = 0
    for i in range(nmap):
        _id, wp, tp = struct.unpack_from("<IHH", b, rec + i * 8)
        n += (wp != NONE) + (tp != NONE)
    pg = rec + nmap * 8
    n += sum(struct.unpack_from("<H", b, pg + i * 2)[0] != NONE for i in range(npage))
    return n


def stats(path):
    """(verts, stamps, emote_page_rows, colour_bindings) for a pak."""
    b = open(path, "rb").read()
    s = sections(b)
    chnk = s["CHNK"][0]
    verts = struct.unpack_from("<I", b, chnk + 12)[0] // 16
    stamps = struct.unpack_from("<I", b, s["STMP"][0] + 4)[0] if "STMP" in s else 0
    # The emote page, by META.emote_page (offset 20) — the field-effect
    # frames are appended to it, so its height is how we tell a re-cooked pak
    # from an old one. Guessing by page shape picks a walk sheet instead.
    ep = struct.unpack_from("<I", b, s["META"][0] + 20)[0]
    ao = s["ATLS"][0]
    rows = 0
    if ep != 0xFFFFFFFF and ep < struct.unpack_from("<H", b, ao)[0]:
        _w, h, _k, _f, _o, _l = struct.unpack_from("<HHHHII", b, ao + 2 + ep * 16)
        rows = h // 16
    return verts, stamps, rows, bindings(b, s)


def md5(p):
    return hashlib.md5(open(p, "rb").read()).hexdigest()


def main():
    args = sys.argv[1:]
    # liftBlock leaving the floor behind means a stamp cell that was PURE
    # floor now has nothing left to lift, so its record disappears and the
    # count legitimately drops. That is the one case the stamps guard has to
    # be told about; it still refuses a collapse to zero.
    stamps_may_drop = "--stamps-may-drop" in args
    # The other deliberate collapse: a map moved onto the box tree path sheds
    # most of its vertices on purpose (BOX_TREES_MAPS in cook/trees.ts).
    verts_may_drop = "--verts-may-drop" in args
    args = [a for a in args if a not in ("--stamps-may-drop", "--verts-may-drop")]
    gd = os.path.join(PAKS, "gamedata.json")
    data = json.load(open(gd))
    if args == ["--cut-trees"]:
        args = sorted(n for n, m in data["maps"].items() if (m.get("cuttableCells") or []))
    elif args == ["--all"]:
        # Every pak that exists, not every map that could be cooked — a
        # shared-page change (the UI atlas, say) invalidates exactly these.
        args = sorted(f[:-6] for f in os.listdir(PAKS) if f.endswith(".vxpak"))
    if not args:
        print(__doc__)
        return 2
    for label, path in (("voxel-height profile", PROFILE), ("gen1recomp", G1R)):
        if not os.path.isdir(path):
            print(f"{label} dir missing: {path}")
            return 1

    before = md5(gd)
    os.makedirs(TMP, exist_ok=True)
    env = dict(os.environ, VOXELMON_VOXELMOD=PROFILE, VOXELMON_G1R=G1R,
               PATH=os.path.expanduser("~/.bun/bin") + ":" + os.environ["PATH"])
    ok, skipped = [], []
    for i, name in enumerate(args, 1):
        dst = os.path.join(PAKS, name + ".vxpak")
        out = os.path.join(TMP, name + ".vxpak")
        print(f"[{i}/{len(args)}] {name} ... ", end="", flush=True)
        r = subprocess.run(
            ["bun", "voxelmon/cook/cli.ts", "--maps", name, "--out", out],
            cwd=ROOT, env=env, capture_output=True, text=True, timeout=1800)
        if r.returncode != 0 or not os.path.exists(out):
            print("COOK FAILED")
            print(r.stderr[-500:])
            skipped.append((name, "cook failed"))
            continue
        log = r.stderr + r.stdout
        for needle, why in (("profile not found", "height profile not loaded"),
                            ("color pack not found", "RED++ colours not loaded")):
            if needle in log:
                break
        else:
            why = None
        if why:
            print(f"REFUSED — {why}")
            skipped.append((name, why))
            continue
        nv, ns, nr, nc = stats(out)
        ov, os_, orr, oc = stats(dst) if os.path.exists(dst) else (0, 0, 0, 0)
        # Guard rails: geometry must not collapse, and neither stamps nor the
        # RED++ colour bindings may go backwards. Zero bindings is grayscale.
        if ov and nv < ov * 0.9 and not (verts_may_drop and nv > 0):
            print(f"REFUSED verts {ov} -> {nv}")
            skipped.append((name, f"verts {ov}->{nv}"))
            continue
        if ov and nv < ov * 0.9:
            print(f"   (verts {ov} -> {nv}, allowed by --verts-may-drop)")
        if ns < os_ and not (stamps_may_drop and ns > 0):
            print(f"REFUSED stamps {os_} -> {ns}")
            skipped.append((name, f"stamps {os_}->{ns}"))
            continue
        if ns < os_:
            print(f"   (stamps {os_} -> {ns}, allowed by --stamps-may-drop)")
        if nc == 0 or nc < oc:
            print(f"REFUSED colour bindings {oc} -> {nc}")
            skipped.append((name, f"colour {oc}->{nc}"))
            continue
        shutil.copyfile(out, dst)
        print(f"ok  verts {ov}->{nv}  stamps {os_}->{ns}  "
              f"emoteRows {orr}->{nr}  colour {oc}->{nc}")
        ok.append(name)

    # the cook wrote its own gamedata.json next to --out, not over ours
    after = md5(gd)
    print(f"\ninstalled {len(ok)}, skipped {len(skipped)}")
    for n, why in skipped:
        print(f"  SKIP {n}: {why}")
    print("gamedata.json unchanged" if before == after else "gamedata.json CHANGED — restore it!")
    return 0 if not skipped and before == after else 1


sys.exit(main())
