#!/bin/bash
# Test tool, not shipped: pocket-voxel's Rust PVS1 peer against the PC mod
# itself (its SYNC screen in the PC game's real save code, headless), for
# Red and Blue, both directions, the saves made and read by this port.
#
#   bash tools/pvsync/pc_e2e.sh <gen1recomp checkout> <pvsync mod dir>
#
# The mod is copied into the checkout's mods/pvsync for the run and removed
# afterwards; nothing else in the checkout is touched.
set -u
G1R=$(cd "${1:?gen1recomp checkout}" && pwd)
MOD=$(cd "${2:?pvsync mod dir}" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
(cd "$ROOT" && CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-3} cargo build -q --offline -p pocketvoxel-sync --bin pvsync-peer) || exit 1
PEER="$ROOT/target/debug/pvsync-peer"
[ -e "$G1R/mods/pvsync" ] && { echo "$G1R/mods/pvsync exists; not touching it"; exit 1; }
W=$(mktemp -d)
cp -r "$MOD" "$G1R/mods/pvsync"
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$G1R/mods/pvsync" "$W"' EXIT
PASS=0; FAIL=0
ok() { echo "PASS $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL $1"; FAIL=$((FAIL+1)); sed 's/^/    /' "$W/pc.log" "$W/peer.log" 2>/dev/null | tail -25; }
gen() { case $1 in red) echo "$ROOT/dist/voxelmon/gen" ;; blue) echo "$ROOT/dist/voxelmon/blue/gen" ;; esac; }
saves() { (cd "$ROOT" && bun tools/pvsync/saves.ts "$@"); }

# the 3DS's save reaches the PC game: GET on the PC, the PC's own install
get() { # game file name expect label
  "$PEER" --game $1 --name $3 --serve "$2" --udp 47710 --tcp 47711 --target 127.0.0.1:47610 --seconds 20 > "$W/peer.log" 2>&1 &
  local p=$!
  (cd "$G1R" && luajit "$HERE/pc_e2e.lua" get $1 $3 "$4") > "$W/pc.log" 2>&1
  local rc=$?
  kill $p 2>/dev/null; wait $p 2>/dev/null
  [ $rc = 0 ] && ok "$5" || bad "$5"
}

# the PC game's save reaches the 3DS: GET on the 3DS, this port's install,
# then CONTINUE and SAVE in this port
put() { # game label
  rm -rf "$W/sd"; mkdir -p "$W/sd"
  (cd "$G1R" && luajit "$HERE/pc_e2e.lua" serve $1 12) > "$W/pc.log" 2>&1 &
  local p=$!
  sleep 1
  "$PEER" --game $1 --pull --udp 47710 --tcp 47711 --target 127.0.0.1:47610 --install "$W/sd/save.lua" --backups "$W/sd/sync_backups" --seconds 10 > "$W/peer.log" 2>&1
  local rc=$?
  wait $p
  if [ $rc = 0 ] && grep -q "INSTALLED version=$1 name=PCSIDE" "$W/peer.log"; then
    saves check "$(gen $1)" $1 "$W/sd/save.lua" > "$W/check.log" 2>&1
    if grep -q "loaded name=PCSIDE version=$1" "$W/check.log" && grep -q "saved version=$1" "$W/check.log"; then ok "$2"; else cat "$W/check.log" >> "$W/peer.log"; bad "$2"; fi
  else
    bad "$2"
  fi
}

for g in red blue; do
  saves make "$(gen $g)" $g "$W/${g}_3ds.lua" - DS${g^^} > /dev/null || exit 1
done
saves make "$(gen blue)" blue "$W/blue_old.lua" red DSOLD > /dev/null || exit 1
grep -q 'version = "blue"' "$W/blue_3ds.lua" && ok "this port's Blue writes version blue" || bad "blue save version"

get red  "$W/red_3ds.lua"  DSRED  "GOT DSRED"  "3DS Red save -> PC Red: installed by the PC"
get blue "$W/blue_3ds.lua" DSBLUE "GOT DSBLUE" "3DS Blue save -> PC Blue: version check passes, installed"
get blue "$W/blue_old.lua" DSOLD  "REFUSED: SAVE IS RED" "an old red-tagged Blue save -> PC Blue: refused (why Blue now writes blue)"
put red  "PC Red save -> 3DS Red: installed here, CONTINUE and SAVE keep red"
put blue "PC Blue save -> 3DS Blue: installed here, CONTINUE and SAVE keep blue"
# the old save once it has been continued and saved here
saves check "$(gen blue)" blue "$W/blue_old.lua" > "$W/check.log" 2>&1
grep -q "loaded name=DSOLD version=blue" "$W/check.log" && grep -q "saved version=blue" "$W/check.log" && ok "the old red-tagged Blue save continues here and saves as blue" || { cat "$W/check.log" > "$W/peer.log"; bad "old blue save rewritten"; }

echo "pc e2e: $PASS passed, $FAIL failed"
[ $FAIL = 0 ]
