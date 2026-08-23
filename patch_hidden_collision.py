#!/usr/bin/env python3
# Fix stuck collision after picking up an item: a hidden object (picked-up
# poke ball / fossil, departed rival) still blocked its tile and was talkable.
# occupied() and npcAtCell() now skip hidden entities. Build-only.
import base64, json, os, sys
ROOT = os.path.expanduser("~/pocket-voxel")
if not os.path.isdir(os.path.join(ROOT, "voxelmon")): ROOT = os.getcwd()
DATA = json.loads(base64.b64decode("eyJodW5rcyI6W3sicGF0aCI6InZveGVsbW9uL2dhbWUvd29ybGQvY29sbGlzaW9uLnRzIiwib2xkIjoiSUNBZ0lHbG1JQ2hsSUNFOVBTQnBaMjV2Y21VZ0ppWWdJV1V1Y0dGemMyRmliR1VwSUhzSyIsIm5ldyI6IklDQWdJQzh2SUVocFpHUmxiaUJsYm5ScGRHbGxjeUFvWVNCd2FXTnJaV1F0ZFhBZ2FYUmxiU0JpWVd4c0xDQmhJR1JsY0dGeWRHVmtJSEpwZG1Gc0tTQnNaV0YyWlNCdWJ3b2dJQ0FnTHk4Z1kyOXNiR2x6YVc5dUlPS0FsQ0IwYUdWNUozSmxJRzV2ZENCa2NtRjNiaUJoYm1RZ2MyaHZkV3hrYmlkMElHSnNiMk5ySUhSb1pTQjBhV3hsSUhSb1pYa2dkMlZ5WlNCdmJpNEtJQ0FnSUdsbUlDaGxJQ0U5UFNCcFoyNXZjbVVnSmlZZ0lXVXVjR0Z6YzJGaWJHVWdKaVlnSVNobElHRnpJSHNnYUdsa1pHVnVQem9nWW05dmJHVmhiaUI5S1M1b2FXUmtaVzRwSUhzSyJ9LHsicGF0aCI6InZveGVsbW9uL2dhbWUvd29ybGQvb3ZlcndvcmxkLnRzIiwib2xkIjoiSUNBZ0lDQWdJQ0FvYm5CakxtTmxiR3hZSUQwOVBTQmplQ0FtSmlCdWNHTXVZMlZzYkZrZ1BUMDlJR041S1NCOGZDQW9ibkJqTG5SaGNtZGxkRmdnUFQwOUlHTjRJQ1ltSUc1d1l5NTBZWEpuWlhSWklEMDlQU0JqZVNrc0NnPT0iLCJuZXciOiJJQ0FnSUNBZ0lDQWhLRzV3WXlCaGN5QjdJR2hwWkdSbGJqODZJR0p2YjJ4bFlXNGdmU2t1YUdsa1pHVnVJQ1ltQ2lBZ0lDQWdJQ0FnS0NodWNHTXVZMlZzYkZnZ1BUMDlJR040SUNZbUlHNXdZeTVqWld4c1dTQTlQVDBnWTNrcElIeDhJQ2h1Y0dNdWRHRnlaMlYwV0NBOVBUMGdZM2dnSmlZZ2JuQmpMblJoY21kbGRGa2dQVDA5SUdONUtTa3NDZz09In1dLCJzZW50aW5lbHMiOnsidm94ZWxtb24vZ2FtZS93b3JsZC9jb2xsaXNpb24udHMiOiJIaWRkZW4gZW50aXRpZXMgKGEgcGlja2VkLXVwIGl0ZW0iLCJ2b3hlbG1vbi9nYW1lL3dvcmxkL292ZXJ3b3JsZC50cyI6Im5wYyBhcyB7IGhpZGRlbj86IGJvb2xlYW4gfSkuaGlkZGVuICYmIn19"))
for rel, marker in DATA["sentinels"].items():
    p = os.path.join(ROOT, rel)
    if os.path.isfile(p) and marker in open(p, encoding="utf-8").read():
        sys.exit("ABORT: already applied ({}).".format(rel))
files = {}
for h in DATA["hunks"]:
    p = os.path.join(ROOT, h["path"])
    if p not in files:
        if not os.path.isfile(p): sys.exit("ABORT: missing " + h["path"])
        files[p] = open(p, encoding="utf-8").read()
    old = base64.b64decode(h["old"]).decode()
    if files[p].count(old) != 1: sys.exit("ABORT: anchor not unique in {} -- nothing written.".format(h["path"]))
for h in DATA["hunks"]:
    p = os.path.join(ROOT, h["path"])
    files[p] = files[p].replace(base64.b64decode(h["old"]).decode(), base64.b64decode(h["new"]).decode(), 1)
for p, t in files.items(): open(p, "w", encoding="utf-8").write(t)
print("PATCHED: hidden objects no longer block movement or accept talk.")
