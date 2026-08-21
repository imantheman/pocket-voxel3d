#!/usr/bin/env python3
# Oak-in-lab fix + placeNpc reveal: returning to Oak's Lab with the parcel now
# spawns the real Oak (with his TEXT_OAKSLAB_OAK1 talk) at his desk, so the
# Pokedex delivery cutscene can trigger. Self-verifying anchors.
import base64, json, os, sys
ROOT = os.path.expanduser("~/pocket-voxel")
if not os.path.isdir(os.path.join(ROOT, "voxelmon")):
    ROOT = os.getcwd()
DATA = json.loads(base64.b64decode(
"eyJodW5rcyI6W3sicGF0aCI6InZveGVsbW9uL2dhbWUvd29ybGQvb3ZlcndvcmxkLnRzIiwib2xkIjoiSUNBZ0lHTnZibk4wSUdWNGFYTjBhVzVuSUQwZ2RHaHBjeTVtYVc1a1RuQmpLSE53Y21sMFpTazdDZz09IiwibmV3IjoiSUNBZ0lHeGxkQ0JsZUdsemRHbHVaeUE5SUhSb2FYTXVabWx1WkU1d1l5aHpjSEpwZEdVcE93b2dJQ0FnTHk4Z1NXWWdkR2hsSUhOd2NtbDBaU0JvWVhNZ2JtOGdkbWx6YVdKc1pTQmhZM1J2Y2l3Z2NISmxabVZ5SUZKRlZrVkJURWxPUnlCMGFHVWdiV0Z3SjNNZ2NtVmhiQW9nSUNBZ0x5OGdLSE53WVhkdUxXaHBaR1JsYmlrZ2IySnFaV04wSUdadmNpQnBkQ0J2ZG1WeUlHRWdjM2x1ZEdobGRHbGpJRzl1WlRvZ2NHOXJaWEpsWkNCSWFXUmxUMkpxWldOMEozTUtJQ0FnSUM4dklFOWhheUF2SUhSb1pTQnlhWFpoYkNCMWJuUnBiQ0JoSUZOb2IzZFBZbXBsWTNRc0lHRnVaQ0J2Ym14NUlIUm9aU0J5WldGc0lHOWlhbVZqZENCallYSnlhV1Z6SUhSb1pRb2dJQ0FnTHk4Z1pHVm1MblJsZUhRZ2RHRnNhMVJ2SUdScGMzQmhkR05vWlhNZ2IyNGdLRlJGV0ZSZlQwRkxVMHhCUWw5UFFVc3hLUzRnUVNCemVXNTBhR1YwYVdNZ1lXTjBiM0lnYUdGekNpQWdJQ0F2THlCdWJ5QjBaWGgwTENCemJ5QjBZV3hyYVc1bklIUnZJR2wwSUhkdmRXeGtJR1J2SUc1dmRHaHBibWN1Q2lBZ0lDQnBaaUFvSVdWNGFYTjBhVzVuS1NCN0NpQWdJQ0FnSUdOdmJuTjBJR1JsWmlBOUlDaDBhR2x6TG0xaGNDNWtaV1l1YjJKcVpXTjBjeUEvUHlCYlhTa3VabWx1WkNnS0lDQWdJQ0FnSUNBb2J5a2dQVDRnYnk1emNISnBkR1VnUFQwOUlITndjbWwwWlNBbUppQWhkR2hwY3k1dWNHTnpMbk52YldVb0tHNHBJRDArSUc0dVpHVm1JRDA5UFNCdktTd0tJQ0FnSUNBZ0tUc0tJQ0FnSUNBZ2FXWWdLR1JsWmlrZ2V3b2dJQ0FnSUNBZ0lHVjRhWE4wYVc1bklEMGdkR2hwY3k1d2IyOXNaV1JPVUVNb2RHaHBjeTV0WVhBdWFXUXNJR1JsWmlrN0NpQWdJQ0FnSUNBZ2RHaHBjeTV1Y0dOekxuQjFjMmdvWlhocGMzUnBibWNwT3dvZ0lDQWdJQ0FnSUhSb2FYTXVaVzUwYVhScFpYTWdQU0JiZEdocGN5NXdiR0Y1WlhJc0lDNHVMblJvYVhNdWJuQmpjMTA3Q2lBZ0lDQWdJSDBLSUNBZ0lIMEsifSx7InBhdGgiOiJ2b3hlbG1vbi9nYW1lL3dvcmxkL21hcHNjcmlwdHMudHMiLCJvbGQiOiJJQ0JQUVV0VFgweEJRam9nZXdvPSIsIm5ldyI6IklDQlBRVXRUWDB4QlFqb2dld29nSUNBZ0x5OGdUMkZySjNNZ2IzWmxjbmR2Y214a0lITndjbWwwWlNCcGN5QklhV1JsVDJKcVpXTjBKMlFnYVc0Z2RHaGxJRkpQVFNCMWJuUnBiQ0IwYUdVZ2FXNTBjbThuY3dvZ0lDQWdMeThnVTJodmQwOWlhbVZqZENBb2MyTnlhWEIwY3k5UFlXdHpUR0ZpTG1GemJTa3VJRlJvWlNCd2IzSjBJRzl1YkhrZ2NtVjJaV0ZzY3lCb2FXMGdkSEpoYm5OcFpXNTBiSGtLSUNBZ0lDOHZJR1IxY21sdVp5QjBhR1VnVUdGc2JHVjBJR1Z6WTI5eWRDd2djMjhnYjI0Z1lTQnNZWFJsY2lCMmFYTnBkQ0FvY21WMGRYSnVhVzVuSUhkcGRHZ2dkR2hsQ2lBZ0lDQXZMeUJ3WVhKalpXd3BJR2hsSUdseklHWnBiSFJsY21Wa0lHOTFkQ0JoZENCemNHRjNiaUJoYm1RZ2RHaGxjbVVnYVhNZ2JtOGdiMjVsSUhSdklIUmhiR3NnZEc4dUNpQWdJQ0F2THlCU1pTMXdiR0ZqWlNCMGFHVWdjbVZoYkNCUFlXc2diMkpxWldOMElHRjBJR2hwY3lCa1pYTnJJRzl1SUdWdWRISjVJRzl1WTJVZ2RHaGxJR2x1ZEhKdklHaGhjd29nSUNBZ0x5OGdjblZ1T3lCd2JHRmpaVTV3WXlCeVpYVnpaWE1nZEdobElHaHBaR1JsYmlCdFlYQWdiMkpxWldOMExDQnpieUJvWlNCclpXVndjeUJvYVhNS0lDQWdJQzh2SUZSRldGUmZUMEZMVTB4QlFsOVBRVXN4SUhSaGJHc2daR2x6Y0dGMFkyZ3VJRUVnYzJsa1pTQmxabVpsWTNRZ2IyNXNlU0F0TFNCeVpYUjFjbTV6SUc1MWJHd2djMjhLSUNBZ0lDOHZJSFJvWlNCeWFYWmhiQzFpWVhSMGJHVWdhRzl6ZENCdmJsTjBaWEFnS0U5QlMxTmZURUZDWDA5T1UxUkZVRjlJVDFOVUtTQnpkR2xzYkNCeWRXNXpJSFJvYVhNZ2MzUmxjQzRLSUNBZ0lHOXVVM1JsY0RvZ0tHOTNPaUJoYm5rc0lITmhkbVU2SUdGdWVTa2dQVDRnZXdvZ0lDQWdJQ0JqYjI1emRDQm1JRDBnYzJGMlpUOHVabXhoWjNNZ1B6OGdlMzA3Q2lBZ0lDQWdJR2xtSUNobUxrVldSVTVVWDBaUFRFeFBWMFZFWDA5QlMxOUpUbFJQWDB4QlFpQjhmQ0JtTGtWV1JVNVVYMGRQVkY5VFZFRlNWRVZTS1NCN0NpQWdJQ0FnSUNBZ2FXWWdLQ0Z2ZHk1bWFXNWtUbkJqUHk0b0lsTlFVa2xVUlY5UFFVc2lLU2tnYjNjdWNHeGhZMlZPY0dNL0xpZ2lVMUJTU1ZSRlgwOUJTeUlzSURVc0lESXNJQ0prYjNkdUlpazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ2NtVjBkWEp1SUc1MWJHdzdDaUFnSUNCOUxBbz0ifV0sInNlbnRpbmVscyI6eyJ2b3hlbG1vbi9nYW1lL3dvcmxkL292ZXJ3b3JsZC50cyI6InByZWZlciBSRVZFQUxJTkcgdGhlIG1hcCdzIHJlYWwiLCJ2b3hlbG1vbi9nYW1lL3dvcmxkL21hcHNjcmlwdHMudHMiOiJ0aGUgcml2YWwtYmF0dGxlIGhvc3Qgb25TdGVwIn19"
))
hunks = DATA["hunks"]; sentinels = DATA["sentinels"]
for rel, marker in sentinels.items():
    p = os.path.join(ROOT, rel)
    if os.path.isfile(p) and marker in open(p, encoding="utf-8").read():
        sys.exit("ABORT: '{}' already present in {} -- patch already applied.".format(marker, rel))
files = {}
for h in hunks:
    p = os.path.join(ROOT, h["path"])
    if p not in files:
        if not os.path.isfile(p): sys.exit("ABORT: missing file " + h["path"])
        files[p] = open(p, encoding="utf-8").read()
    old = base64.b64decode(h["old"]).decode()
    n = files[p].count(old)
    if n != 1:
        sys.exit("ABORT: anchor in {} matched {} times (need 1) -- did last patch apply? nothing written.".format(h["path"], n))
for h in hunks:
    p = os.path.join(ROOT, h["path"])
    files[p] = files[p].replace(base64.b64decode(h["old"]).decode(), base64.b64decode(h["new"]).decode(), 1)
conf = {}
for p, text in files.items():
    open(p, "w", encoding="utf-8").write(text)
    conf[os.path.relpath(p, ROOT)] = {"bytes": len(text)}
print("PATCHED (root=" + ROOT + "):")
print(json.dumps(conf, indent=2))
print("fix: OAKS_LAB.onStep re-places real Oak at desk; placeNpc reveals hidden map objects")
