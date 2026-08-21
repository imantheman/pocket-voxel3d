#!/usr/bin/env python3
# Battle sprites: 40% smaller (draw.rs BATTLE_CARD_SCALE) and front-facing on
# both sides (staging.ts picPageFor for the player). Rebuild bun + cargo.
import base64, json, os, sys
ROOT = os.path.expanduser("~/pocket-voxel")
if not os.path.isdir(os.path.join(ROOT, "voxelmon")): ROOT = os.getcwd()
DATA = json.loads(base64.b64decode("eyJodW5rcyI6W3sicGF0aCI6ImNyYXRlcy9wb2NrZXR2b3hlbC1jb3JlL3NyYy9kcmF3LnJzIiwib2xkIjoiSUNBZ0lDQWdJQ0FnSUNBZ2ZUc0tJQ0FnSUNBZ0lDQWdJQ0FnYVhSbGJYTXVjSFZ6YUNoSmRHVnRPanBEWVhKa0lIc0siLCJuZXciOiJJQ0FnSUNBZ0lDQWdJQ0FnZlRzS0lDQWdJQ0FnSUNBZ0lDQWdMeThnUW1GMGRHeGxJRzF2YmlCemNISnBkR1Z6SUdSeVlYZHVJR0YwSURZd0pTQW9OREFsSUhOdFlXeHNaWElwSUc5bUlIUm9aV2x5SUdGMGJHRnpDaUFnSUNBZ0lDQWdJQ0FnSUM4dklIQmhaMlVnYzJsNlpUc2diM1psY25kdmNteGtJR1Z1ZEdsMGVTQmpZWEprY3lCMWMyVWdZMkZ5WkY5M0lHRnVaQ0JoY21VZ2RXNWhabVpsWTNSbFpDNEtJQ0FnSUNBZ0lDQWdJQ0FnWTI5dWMzUWdRa0ZVVkV4RlgwTkJVa1JmVTBOQlRFVTZJR1l6TWlBOUlEQXVOanNLSUNBZ0lDQWdJQ0FnSUNBZ2FYUmxiWE11Y0hWemFDaEpkR1Z0T2pwRFlYSmtJSHNLIn0seyJwYXRoIjoiY3JhdGVzL3BvY2tldHZveGVsLWNvcmUvc3JjL2RyYXcucnMiLCJvbGQiOiJJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lIWmxjblJ6T2lCallYSmtYM1psY25SektHTmxiR3hmWTJWdWRISmxLR05oY21RdWVDd2dZMkZ5WkM1NUtTd2djR0ZuWlM1M0lHRnpJR1l6TWl3Z2NHRm5aUzVvSUdGeklHWXpNaXdnWVNrc0NnPT0iLCJuZXciOiJJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lIWmxjblJ6T2lCallYSmtYM1psY25SektBb2dJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJR05sYkd4ZlkyVnVkSEpsS0dOaGNtUXVlQ3dnWTJGeVpDNTVLU3dLSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNCd1lXZGxMbmNnWVhNZ1pqTXlJQ29nUWtGVVZFeEZYME5CVWtSZlUwTkJURVVzQ2lBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ2NHRm5aUzVvSUdGeklHWXpNaUFxSUVKQlZGUk1SVjlEUVZKRVgxTkRRVXhGTEFvZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lHRXNDaUFnSUNBZ0lDQWdJQ0FnSUNBZ0lDQXBMQW89In0seyJwYXRoIjoidm94ZWxtb24vZ2FtZS9iYXR0bGUvc3RhZ2luZy50cyIsIm9sZCI6IklDQWdJR052Ym5OMElIQnBZeUE5SUdKaFkydFFZV2RsUm05eUtHUmhkR0VzSUdKaGRIUnNaUzV3YkdGNVpYSXViVzl1TG5Od1pXTnBaWE1wT3dvPSIsIm5ldyI6IklDQWdJQzh2SUVaeWIyNTBMV1poWTJsdVp5QnpjSEpwZEdWeklHOXVJR0p2ZEdnZ2MybGtaWE1nWm05eUlHNXZkeUFvZDJGeklHSmhZMnRRWVdkbFJtOXlLUzRLSUNBZ0lHTnZibk4wSUhCcFl5QTlJSEJwWTFCaFoyVkdiM0lvWkdGMFlTd2dZbUYwZEd4bExuQnNZWGxsY2k1dGIyNHVjM0JsWTJsbGN5azdDZz09In1dLCJzZW50aW5lbHMiOnsiY3JhdGVzL3BvY2tldHZveGVsLWNvcmUvc3JjL2RyYXcucnMiOiJCQVRUTEVfQ0FSRF9TQ0FMRSIsInZveGVsbW9uL2dhbWUvYmF0dGxlL3N0YWdpbmcudHMiOiJGcm9udC1mYWNpbmcgc3ByaXRlcyBvbiBib3RoIHNpZGVzIn19"))
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
print("PATCHED: battle sprites 60% size, front-facing both sides.")
