#!/usr/bin/env python3
"""The transitions bench's table (platform/bench_load.ts, main.ts in bench mode
with PV_G3_BENCH_SCRIPT=load): per marked transition, the worst frame and the
frames shown late, from pvlog.txt's "[pv] g3 hitch:" lines (gen3/pace.rs logs
every frame shown more than 36 ms after the one before it) and the marks.

  python3 tools/gen3/load_table.py pvlog.txt [more.txt ...] [-v]

Several logs side by side: one pair of columns each (before / after). Marks
starting "~" are the bench's own work (a route search) and are left out.
-v lists each transition's hitch lines and the host's map loads under it.
"""
import re
import sys

MARK = re.compile(r"\[pv\] g3 mark: (.*?)(?: \(tick \d+.*\))?$")
HITCH = re.compile(r"\[pv\] g3 hitch: frame (\d+) (\d+) ms")


def parse(path):
    segs = {}
    order = []
    detail = {}
    cur = "(boot)"
    with open(path, encoding="utf-8", errors="replace", newline="") as f:
        for raw in f:
            line = raw.rstrip("\r\n")
            m = MARK.search(line)
            if m:
                name = m.group(1).split(";")[0].strip()
                if name.startswith("menu entries") or "start failed" in name or "still on" in name or "no warp" in name:
                    detail.setdefault(cur, []).append(line)
                    continue
                cur = name
                if cur not in segs:
                    segs[cur] = []
                    order.append(cur)
                continue
            h = HITCH.search(line)
            if h:
                segs.setdefault(cur, []).append(int(h.group(2)))
                if cur not in order:
                    order.append(cur)
                detail.setdefault(cur, []).append(line)
                continue
            if "[pv] load " in line or "g3 slow" in line or "[pv] pak " in line or "rebuild skipped" in line:
                detail.setdefault(cur, []).append(line)
    return segs, order, detail


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    verbose = "-v" in sys.argv
    runs = [parse(p) for p in args]
    order = []
    for _, o, _ in runs:
        for k in o:
            # "~..." marks are the bench's own (a route search before a walk)
            if k not in order and not k.startswith("~"):
                order.append(k)
    w = max([len(k) for k in order] + [10])
    head = "transition".ljust(w) + "".join(f" | {'worst ms':>8} {'>33ms':>5}" for _ in runs)
    print(head)
    print("-" * len(head))
    for k in order:
        row = k.ljust(w)
        for segs, _, _ in runs:
            v = segs.get(k)
            if v is None:
                row += f" | {'-':>8} {'-':>5}"
            else:
                row += f" | {max(v) if v else 0:>8} {len(v):>5}"
        print(row)
        if verbose:
            for i, (_, _, d) in enumerate(runs):
                for line in d.get(k, []):
                    print(f"    [{i}] {line[line.find('[pv]'):]}")


if __name__ == "__main__":
    main()
