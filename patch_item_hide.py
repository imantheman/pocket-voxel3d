#!/usr/bin/env python3
# Fix: item balls / hidden objects keep drawing after hide_object. The NPC
# render loop never skipped npc.hidden; add the skip so picked-up items and
# departed rivals vanish immediately (not just on map reload). Build-only.
import base64, json, os, sys
ROOT = os.path.expanduser("~/pocket-voxel")
if not os.path.isdir(os.path.join(ROOT, "voxelmon")): ROOT = os.getcwd()
DATA = json.loads(base64.b64decode("eyJodW5rcyI6W3sicGF0aCI6InZveGVsbW9uL2dhbWUvc2NlbmUudHMiLCJvbGQiOiJJQ0FnSUNBZ2FXWWdLSE5zYjNRZ1BqMGdSVTVVVTE5TlFWZ3BJR0p5WldGck93bz0iLCJuZXciOiJJQ0FnSUNBZ2FXWWdLSE5zYjNRZ1BqMGdSVTVVVTE5TlFWZ3BJR0p5WldGck93b2dJQ0FnSUNBdkx5Qm9hV1JsWDI5aWFtVmpkQ0J6WlhSeklHNXdZeTVvYVdSa1pXNDdJSE5yYVhBZ1pXMXBkSFJwYm1jZ2MyOGdkR2hsSUdWdVpDMXZaaTFtY21GdFpRb2dJQ0FnSUNBdkx5QmxiblJUWldWdUlHTnNaV0Z1ZFhBZ2FHbGtaWE1nZEdobElITnNiM1F1SUZkcGRHaHZkWFFnZEdocGN5QmhiaUJ2WW1wbFkzUWdjR2xqYTJWa0lIVndJRzl5Q2lBZ0lDQWdJQzh2SUdocFpHUmxiaUJpZVNCaElITmpjbWx3ZENBb2FYUmxiU0JpWVd4c2N5d2dZU0JrWlhCaGNuUmxaQ0J5YVhaaGJDa2dhMlZsY0hNZ1pISmhkMmx1WnlCMWJuUnBiQW9nSUNBZ0lDQXZMeUIwYUdVZ2JXRndJSEpsYkc5aFpITWdZVzVrSUc5aWFtVmpkRlpwYzJsaWJHVWdabWxzZEdWeWN5QnBkQ0JoZENCemNHRjNiaTRLSUNBZ0lDQWdhV1lnS0NodWNHTWdZWE1nZXlCb2FXUmtaVzQvT2lCaWIyOXNaV0Z1SUgwcExtaHBaR1JsYmlrZ1kyOXVkR2x1ZFdVN0NnPT0ifV0sInNlbnRpbmVscyI6eyJ2b3hlbG1vbi9nYW1lL3NjZW5lLnRzIjoiaGlkZV9vYmplY3Qgc2V0cyBucGMuaGlkZGVuOyBza2lwIGVtaXR0aW5nIn19"))
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
print("PATCHED: hidden npcs now skip rendering (items/rivals vanish on hide_object).")
