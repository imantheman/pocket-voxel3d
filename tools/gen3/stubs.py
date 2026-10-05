#!/usr/bin/env python3
"""Lay down one TypeScript stub per Lua module of gen1recomp's FRLG runtime.

The FireRed runtime is a module-for-module port of bryanthaboi/gen1recomp's
latest (GPLv3 + additional terms; docs/firered-engine.md). Porting ~260
modules in parallel needs every import to resolve before its target is
ported, so this writes a stub for each -- the Lua module's public names, all
typed `any`, each throwing `notPorted` -- and the port of a module replaces
its stub wholesale. (The Gen 2 port did the same: tools/gen2_stubs.py.)

The module list is the static require closure from src/core/Game3.lua
(tools/gen3/runtime_closure.ts writes /tmp/g3runtime.tsv). Mapping:
  src/core/game3/<p>.lua        -> voxelmon/game/gen3/core/<p>.ts
  src/ui/game3/<p>.lua          -> voxelmon/game/gen3/ui/<p>.ts
  src/world/game3, battle/game3 -> voxelmon/game/gen3/world|battle/<p>.ts
  src/core/Game3.lua            -> voxelmon/game/gen3/core/Game3.ts
  any other src/<p>.lua         -> voxelmon/game/gen3/shared/<p>.ts  (only the
                                   shared modules gen3 modules require directly)
  src/import/gba/*              -> not stubbed (voxelmon/import/gen3, ported
                                   by the importer workers)

An existing file is never overwritten unless it still carries the STUB marker.

usage: python3 tools/gen3/stubs.py   (in WSL; reads ~/gen1recomp-latest)
"""
import os
import re

MARK = "// @gen3-stub"
SRC = os.path.expanduser("~/gen1recomp-latest")
REPO = os.path.expanduser("~/pocket-voxel")
OUT = os.path.join(REPO, "voxelmon", "game", "gen3")

# desktop plumbing nothing on the 3DS answers to: inert stubs (return undefined)
INERT = {
    "DiscordPresence", "FaithfulRes", "FrameCap", "GamepadMap", "PresentSync",
    "VSync", "VideoMode", "Performance", "TouchControls", "Letterbox", "Zoom",
    "ScreenPosition", "SafeArea", "Orientation", "Renderer", "PresentProbe",
    "SwitchDiagnostics", "RefreshRate", "Sensors",
}
# deferred: link / online / mystery gift / mods UI -- stubs that throw
DEFERRED = re.compile(r"\.link\.|union_room|union_plaza|mystery_gift|mod_manager|^src\.(link|online|net|sync)\.")
# required dynamically (pcall(require, ...)), so the static closure misses them
EXTRA = ["src.ui.game3.braille", "src.ui.game3.map_name_popup", "src.core.game3.bike",
         "src.core.game3.trainer_fan_club", "src.core.game3.pokemon_size_record", "src.core.game3.roamer",
         "src.core.game3.battle.builtin_moves", "src.core.game3.scripting.collision_std",
         "src.core.game3.itemfinder", "src.core.game3.field_move_show_mon", "src.core.game3.coord_weather",
         "src.core.game3.scripting.natives_corner", "src.ui.game3.whiteout_rush",
         "src.core.game3.renewable_hidden_items", "src.core.game3.rotating_gate", "src.ui.game3.seagallop",
         "src.core.game3.scripting.natives_events"]
# shared modules reached the same way
EXTRA_SHARED = ["src.world.gen2.Permissions"]
# being written by an importer-cluster worker right now: never stub
SKIP_TS = {
    "core/scripting/disasm.ts", "core/scripting/movement.ts", "core/encounters.ts",
    "core/marts.ts", "core/mb.ts",
}


def ts_rel(mod):
    parts = mod.split(".")
    if mod == "src.core.Game3":
        return "core/Game3.ts"
    if len(parts) >= 3 and parts[2] in ("game3",) and parts[1] in ("core", "ui", "world", "battle"):
        return "/".join([parts[1]] + parts[3:]) + ".ts"
    return "/".join(["shared"] + parts[1:]) + ".ts"


def module_info(text, base):
    rets = re.findall(r"^return\s+([A-Za-z_][A-Za-z0-9_]*)\s*$", text, re.M)
    local = rets[-1] if rets else base
    export = base if local in ("M", "_M") else local
    if not re.match(r"^[A-Za-z_$][A-Za-z0-9_$]*$", export):
        export = re.sub(r"[^A-Za-z0-9_$]", "_", export)
    is_class = re.search(r"^%s\.__index\s*=\s*%s\b" % (re.escape(local), re.escape(local)), text, re.M) is not None
    statics, methods, fields = [], [], []
    for m in re.finditer(r"^function\s+%s([.:])([A-Za-z_][A-Za-z0-9_]*)\s*\(" % re.escape(local), text, re.M):
        sep, name = m.groups()
        (methods if sep == ":" else statics).append(name)
    for m in re.finditer(r"^%s\.([A-Za-z_][A-Za-z0-9_]*)\s*=" % re.escape(local), text, re.M):
        if m.group(1) != "__index" and m.group(1) not in fields:
            fields.append(m.group(1))
    fn = set(statics) | set(methods)
    fields = [f for f in fields if f not in fn]
    return export, is_class, statics, methods, fields


def stub(mod, rel, text):
    lua_rel = mod.replace(".", "/") + ".lua"
    base = mod.split(".")[-1]
    export, is_class, statics, methods, fields = module_info(text, base)
    depth = rel.count("/")
    imp = "../" * depth + "notported.ts" if depth else "./notported.ts"
    inert = base in INERT
    deferred = DEFERRED.search(mod) is not None
    what = "Deferred (link/online; not in the first FireRed release)" if deferred else "Not ported yet"
    lines = [
        MARK,
        ("// Inert on the 3DS (desktop-only in gen1recomp %s): every function returns undefined." % lua_rel)
        if inert else "// %s: gen1recomp %s (GPLv3 + additional terms; see LICENSE.md)." % (what, lua_rel),
        "// Generated by tools/gen3/stubs.py; the port replaces this file wholesale.",
        "",
    ]
    if not inert:
        lines += ['import { notPorted } from "%s";' % imp, ""]
    seen = set()
    body = (lambda q: "return undefined;") if inert else (lambda q: 'return notPorted("%s");' % q)
    if is_class or methods:
        lines += ["export class %s {" % export, "  [key: string]: any;", "  static [key: string]: any;"]
        for f in fields:
            lines.append("  static %s: any = undefined;" % f)
        for n in statics:
            if ("s", n) in seen:
                continue
            seen.add(("s", n))
            lines.append("  static %s(..._a: any[]): any { %s }" % (n, body("%s.%s" % (export, n))))
        for n in methods:
            if ("m", n) in seen or n == "constructor":
                continue
            seen.add(("m", n))
            lines.append("  %s(..._a: any[]): any { %s }" % (n, body("%s:%s" % (export, n))))
        lines.append("}")
    else:
        lines.append("export const %s: Record<string, any> = {" % export)
        for f in fields:
            lines.append("  %s: undefined," % f)
        for n in statics:
            if n in seen:
                continue
            seen.add(n)
            lines.append("  %s: (..._a: any[]): any => { %s }," % (n, body("%s.%s" % (export, n))))
        lines.append("};")
    lines.append("export default %s;" % export)
    return "\n".join(lines) + "\n"


rows = [l.rstrip("\n").split("\t") for l in open("/tmp/g3runtime.tsv", encoding="utf-8") if l.strip()]
deps = {r[0]: [d for d in (r[2] if len(r) > 2 else "").split(",") if d] for r in rows}
is_g3 = lambda m: m == "src.core.Game3" or re.match(r"^src\.(core|ui|world|battle)\.game3\.", m) is not None
g3 = sorted(m for m in deps if is_g3(m))
shared = sorted({d for m in g3 for d in deps[m]
                 if not is_g3(d) and not d.startswith("src.import.gba") and d.startswith("src.")
                 and os.path.exists(os.path.join(SRC, d.replace(".", "/") + ".lua"))})
def lua_file(mod):
    p = os.path.join(SRC, mod.replace(".", "/") + ".lua")
    return p if os.path.exists(p) else os.path.join(SRC, mod.replace(".", "/"), "init.lua")


g3 = sorted(set(g3) | set(EXTRA))
shared = sorted(set(shared) | set(EXTRA_SHARED))
wrote = kept = skipped = 0
for mod in g3 + shared:
    rel = ts_rel(mod)
    if rel in SKIP_TS:
        skipped += 1
        continue
    dest = os.path.join(OUT, rel)
    if os.path.exists(dest):
        with open(dest, encoding="latin1") as fh:
            if MARK not in fh.readline():
                kept += 1
                continue
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    text = open(lua_file(mod), encoding="latin1").read()
    with open(dest, "w", encoding="utf-8", newline="") as fh:
        fh.write(stub(mod, rel, text))
    wrote += 1
notp = os.path.join(OUT, "notported.ts")
if not os.path.exists(notp):
    with open(notp, "w", encoding="utf-8", newline="") as fh:
        fh.write("""// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). What a not-yet-ported module does when it is reached: say
// which Lua function it stands for and stop (tools/gen3/stubs.py writes the
// stubs; docs/firered-engine.md tracks the port).

export class NotPortedError extends Error {
  constructor(readonly what: string) {
    super(`gen3: ${what} is not ported yet`);
  }
}

export function notPorted(what: string): never {
  throw new NotPortedError(what);
}
""")
print("gen3 stubs: %d gen3 + %d shared modules; wrote %d, kept %d ported, skipped %d" % (len(g3), len(shared), wrote, kept, skipped))
