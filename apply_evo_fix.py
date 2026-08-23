#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# pocket-voxel patcher: FIX evolution never firing (patcher 5). TS-only (cargo).
#
# The evolution rule (rules/evolution.ts) and its driver (game.runEvolutions)
# were fully present, but the after-battle call to runEvolutions had been left
# in the DEAD half of BattleGameState.update -- after the live path's `return`
# (a leftover from the pop+resume teardown refactor).  So checkParty/apply were
# never invoked and no mon ever evolved.  This moves the call into the live
# path (OverworldController.lua:3851-3894 afterBattle / EvolveAfterBattle).  The
# dex seen+owned flagging on evolve already lives in evolution.apply.
#
# Idempotent; aborts if the anchor is missing/ambiguous.
# Run from ~/pocket-voxel: python3 apply_evo_fix.py
# ---------------------------------------------------------------------------
import base64, sys, os
EDITS = [{'path': 'voxelmon/game/game.ts', 'old': 'ICAgICAgLy8gaXQncyBhIGRlc2lnbmF0ZWQgbG9zZWFibGUgYmF0dGxlICh0aGUgZWFybHkgcml2YWwpLCB3aG9zZSBzY3JpcHQKICAgICAgLy8gaGVhbHMgYW5kIGNvbnRpbnVlcy4gVGhlIGJsb2NrIGJlbG93IGlzIHRoZSBsZWdhY3kgdGVhcmRvd24sIGtlcHQgZm9yCiAgICAgIC8vIGl0cyBub3RlczsgdGhlIGxpdmUgcGF0aCBwb3BzICsgcmVzdW1lcyBhYm92ZSwgc28gYmxhY2tvdXQgZ29lcyBoZXJlLgogICAgICBpZiAoYi5maW5pc2hlZCA9PT0gImxvc2UiICYmICF0aGlzLmxvc2VhYmxlKSB0aGlzLmdhbWUuYmxhY2tvdXQoKTsKICAgICAgcmV0dXJuOwogICAgICAvLyBCYXR0bGVTdGF0ZS5sdWE6NDY0Ny00NjUzIOKAlCB0ZWFyZG93biBwb3BzIHRoZSBiYXR0bGUgc2NyZWVuIEZJUlNULAogICAgICAvLyBhbmQgaXQgaXMgdGhlIG1hcCB0aGF0IGhvbGRzOiBQT1NUX0JBVFRMRV9SRVRVUk4gYmVmb3JlIEVudGVyTWFwCiAgICAgIC8vIChob21lL292ZXJ3b3JsZC5hc206MzUxLTM1MikgYW5kIHRoZW4gTWFwRW50cnlBZnRlckJhdHRsZSdzCg==', 'new': 'ICAgICAgLy8gaXQncyBhIGRlc2lnbmF0ZWQgbG9zZWFibGUgYmF0dGxlICh0aGUgZWFybHkgcml2YWwpLCB3aG9zZSBzY3JpcHQKICAgICAgLy8gaGVhbHMgYW5kIGNvbnRpbnVlcy4gVGhlIGJsb2NrIGJlbG93IGlzIHRoZSBsZWdhY3kgdGVhcmRvd24sIGtlcHQgZm9yCiAgICAgIC8vIGl0cyBub3RlczsgdGhlIGxpdmUgcGF0aCBwb3BzICsgcmVzdW1lcyBhYm92ZSwgc28gYmxhY2tvdXQgZ29lcyBoZXJlLgogICAgICBpZiAoYi5maW5pc2hlZCA9PT0gImxvc2UiICYmICF0aGlzLmxvc2VhYmxlKSB0aGlzLmdhbWUuYmxhY2tvdXQoKTsKICAgICAgLy8gT3ZlcndvcmxkQ29udHJvbGxlci5sdWE6Mzg1MS0zODk0IGFmdGVyQmF0dGxlOiBFdm9sdmVBZnRlckJhdHRsZSBydW5zCiAgICAgIC8vIGZvciBldmVyeSBleGl0ICh0aGUgYmxhY2tvdXQgaGVhbHMgZmlyc3QsIDozODgyOyBvdGhlciBleGl0cyBydW4gaXQKICAgICAgLy8gc3RyYWlnaHQgYXdheSwgOjM4OTIpLiBUaGlzIGNhbGwgd2FzIG9ycGhhbmVkIGluIHRoZSBkZWFkIGxlZ2FjeSBibG9jawogICAgICAvLyBiZWxvdyB3aGVuIHRoZSB0ZWFyZG93biBtb3ZlZCB0byB0aGUgcG9wK3Jlc3VtZSBwYXRoIGFib3ZlIOKAlCB3aXRob3V0IGl0CiAgICAgIC8vIG5vIG1vbiBldmVyIGV2b2x2ZXMuIFRoZSBldm9sdXRpb24gcGFnZXMgcHVzaCBvdmVyIHRoZSBvdmVyd29ybGQgdGhlCiAgICAgIC8vIGJhdHRsZSBqdXN0IGhhbmRlZCBiYWNrIHRvLgogICAgICB0aGlzLmdhbWUucnVuRXZvbHV0aW9ucyhiLmxldmVsZWRVcCk7CiAgICAgIHJldHVybjsKICAgICAgLy8gQmF0dGxlU3RhdGUubHVhOjQ2NDctNDY1MyDigJQgdGVhcmRvd24gcG9wcyB0aGUgYmF0dGxlIHNjcmVlbiBGSVJTVCwKICAgICAgLy8gYW5kIGl0IGlzIHRoZSBtYXAgdGhhdCBob2xkczogUE9TVF9CQVRUTEVfUkVUVVJOIGJlZm9yZSBFbnRlck1hcAogICAgICAvLyAoaG9tZS9vdmVyd29ybGQuYXNtOjM1MS0zNTIpIGFuZCB0aGVuIE1hcEVudHJ5QWZ0ZXJCYXR0bGUncwo='}]
def main():
    root=os.getcwd()
    if not os.path.isdir(os.path.join(root,"voxelmon")):
        sys.exit("! run this from the pocket-voxel repo root")
    changed=skipped=0; by_file={}
    for h in EDITS: by_file.setdefault(h["path"],[]).append(h)
    for path,hs in by_file.items():
        fp=os.path.join(root,path)
        if not os.path.isfile(fp): sys.exit(f"! missing file: {path}")
        text=open(fp,encoding="utf-8").read(); orig=text
        for h in hs:
            old=base64.b64decode(h["old"]).decode(); new=base64.b64decode(h["new"]).decode()
            if new in text: skipped+=1; continue
            n=text.count(old)
            if n==0: sys.exit(f"! anchor not found in {path}\n  (not the expected tree, or already diverged)")
            if n>1: sys.exit(f"! anchor is ambiguous in {path} ({n} matches)")
            text=text.replace(old,new,1); changed+=1
        if text!=orig: open(fp,"w",encoding="utf-8").write(text); print(f"  patched {path}")
    print(f"done: {changed} hunk(s) applied, {skipped} already present")
    if changed==0 and skipped: print("(nothing to do -- already applied)")
if __name__=="__main__": main()
