#!/usr/bin/env python3
# Add ROUTE_22 to DEFAULT_MAPS so Viridian's west exit cooks (prereq for the
# optional early rival battle). Re-cook + redeploy the pak after this.
import base64, json, os, sys
ROOT = os.path.expanduser("~/pocket-voxel")
if not os.path.isdir(os.path.join(ROOT, "voxelmon")):
    ROOT = os.getcwd()
DATA = json.loads(base64.b64decode("eyJodW5rcyI6W3sicGF0aCI6InZveGVsbW9uL2Nvb2svY2xpLnRzIiwib2xkIjoiSUNBaVVrOVZWRVZmTXlJc0NnPT0iLCJuZXciOiJJQ0FpVWs5VlZFVmZNeUlzQ2lBZ0x5OGdWbWx5YVdScFlXNG5jeUJYUlZOVUlHVjRhWFFnS0hKbFlXd2dVazlOSUdOdmJtNWxZM1JwYjI0cExpQkRiMjlyWldRZ1ptOXlJSFJvWlNCdmNIUnBiMjVoYkFvZ0lDOHZJR1ZoY214NUlISnBkbUZzSUdKaGRIUnNaU0JoWm5SbGNpQjBhR1VnY0dGeVkyVnNJR1J5YjNBdGIyWm1JQ2h6ZEc5eWVUVXViSFZoSUZKUFZWUkZYekl5S1M0Z1NYUnpDaUFnTHk4Z2IzZHVJR1poY2lCbGVHbDBjeUFvVW05MWRHVWdNak1zSUhSb1pTQm5ZWFJsS1NCbVlXeHNJRzkxZEhOcFpHVWdZMjl2YTJWa1RXRndjeUJoYm1RZ1lYSmxJR2hsYkdRS0lDQXZMeUJoY3lCMGFHVWdiRzlqYTJWa0lHWnliMjUwYVdWeUlHRjFkRzl0WVhScFkyRnNiSGt1Q2lBZ0lsSlBWVlJGWHpJeUlpd0sifV0sInNlbnRpbmVscyI6eyJ2b3hlbG1vbi9jb29rL2NsaS50cyI6IlwiUk9VVEVfMjJcIiwifX0="))
hunks = DATA["hunks"]; sentinels = DATA["sentinels"]
for rel, marker in sentinels.items():
    p = os.path.join(ROOT, rel)
    if os.path.isfile(p) and marker in open(p, encoding="utf-8").read():
        sys.exit("ABORT: '{}' already present in {} -- already applied.".format(marker, rel))
files = {}
for h in hunks:
    p = os.path.join(ROOT, h["path"])
    if p not in files:
        if not os.path.isfile(p): sys.exit("ABORT: missing " + h["path"])
        files[p] = open(p, encoding="utf-8").read()
    old = base64.b64decode(h["old"]).decode()
    if files[p].count(old) != 1:
        sys.exit("ABORT: anchor in {} not unique -- nothing written.".format(h["path"]))
for h in hunks:
    p = os.path.join(ROOT, h["path"])
    files[p] = files[p].replace(base64.b64decode(h["old"]).decode(), base64.b64decode(h["new"]).decode(), 1)
for p, text in files.items():
    open(p, "w", encoding="utf-8").write(text)
print("PATCHED: ROUTE_22 added to DEFAULT_MAPS. Now re-cook + redeploy the pak.")
