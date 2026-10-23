#!/bin/bash
# Test tool, not shipped: pocket-voxel's Rust PVS1 (pvsync-peer) against the
# PC mod's own transport (its net.lua, under luajit + LuaSocket), both ways:
# pulls, offers, the one-way-broadcast echo and a wrong-game request.
#
#   bash tools/pvsync/cross_test.sh /path/to/pvsync/net.lua
#
# Everything runs on 127.0.0.1 with HELLOs aimed at the other side's port.
set -u
NET_LUA=${1:?path to the pvsync mod net.lua}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
export PATH="$HOME/.cargo/bin:$PATH"
(cd "$ROOT" && CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-3} cargo build -q --offline -p pocketvoxel-sync --bin pvsync-peer) || exit 1
PEER="$ROOT/target/debug/pvsync-peer"
DRV="$HERE/net_driver.lua"
W=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$W"' EXIT
RU=47710; RT=47711; LU=47720; LT=47721
PASS=0; FAIL=0
ok() { echo "PASS $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL $1"; FAIL=$((FAIL+1)); sed 's/^/    /' "$W/rust.log" "$W/lua.log" 2>/dev/null | tail -20; }

# a ~300 KB save that is valid data: version, player name, a long string
cat > "$W/gen.lua" <<'EOF'
local t = {} ; local s = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 "
for i = 1, 300 * 1024 do local k = (i * 7919) % #s + 1 ; t[i] = s:sub(k, k) end
local f = io.open(arg[1], "wb")
f:write("return {\n  player = {\n    name = \"CROSS\",\n  },\n  version = \"", arg[2], "\",\n  blob = \"", table.concat(t), "\",\n}\n")
f:close()
f = io.open(arg[3], "wb")
f:write("return {\n  player = {\n    name = \"LUASIDE\",\n  },\n  version = \"red\",\n}\n")
f:close()
EOF
cat > "$W/crc.lua" <<'EOF'
local net = dofile(arg[1])(require("socket"), require("bit"))
local f = io.open(arg[2], "rb"); print(net.crc32(f:read("*a"))); f:close()
EOF
luajit "$W/gen.lua" "$W/red.lua" red "$W/red_small.lua"
same() { cmp -s "$1" "$2"; }

run() { # name, rust args..., --, lua args...
  local name=$1; shift
  local ra=() la=()
  while [ "$1" != "--" ]; do ra+=("$1"); shift; done; shift
  la=("$@")
  "$PEER" --udp $RU --tcp $RT "${ra[@]}" > "$W/rust.log" 2>&1 &
  local rp=$!
  luajit "$DRV" "$NET_LUA" "${la[@]}" > "$W/lua.log" 2>&1 &
  local lp=$!
  wait $lp; LUA_RC=$?
  wait $rp; RUST_RC=$?
}

# 1. the PC side pulls the 3DS side's save (Rust serves, Lua GETs)
run "lua pulls from rust" --game red --target 127.0.0.1:$LU --serve "$W/red.lua" --seconds 6 -- pull red $LU $LT $RU "$W/got1.lua" 10
[ $LUA_RC = 0 ] && same "$W/red.lua" "$W/got1.lua" && grep -q "PEER [0-9a-f]* 3ds red" "$W/lua.log" && ok "1 lua pulls a 300 KB save from rust" || bad "1 lua pulls from rust"

# 2. the 3DS side pulls the PC side's save and installs it
mkdir -p "$W/sd"
printf 'return {\n  version = "red",\n  player = { name = "OLD" },\n}\n' > "$W/sd/save.lua"
run "rust pulls from lua" --game red --target 127.0.0.1:$LU --pull --out "$W/got2.lua" --install "$W/sd/save.lua" --backups "$W/sd/sync_backups" --seconds 10 -- serve red $LU $LT $RU "$W/red.lua" 6
[ $RUST_RC = 0 ] && same "$W/red.lua" "$W/got2.lua" && same "$W/red.lua" "$W/sd/save.lua" && grep -q 'INSTALLED version=red name=CROSS' "$W/rust.log" \
  && [ -f "$W/sd/save.lua.bak" ] && [ "$(ls "$W/sd/sync_backups" | wc -l)" = 1 ] && ok "2 rust pulls from lua and installs (backup + .bak)" || bad "2 rust pulls from lua"

# 3. SEND on the 3DS side: Rust OFFERs, Lua accepts and pulls
run "rust offers" --game red --target 127.0.0.1:$LU --serve "$W/red.lua" --offer --seconds 6 -- accept red $LU $LT $RU "$W/got3.lua" 10
[ $LUA_RC = 0 ] && grep -q '^OFFER ' "$W/lua.log" && same "$W/red.lua" "$W/got3.lua" && ok "3 rust OFFER -> lua ACCEPT" || bad "3 rust offers"

# 4. SEND on the PC side: Lua OFFERs, Rust accepts and pulls
run "lua offers" --game red --target 127.0.0.1:$LU --accept --out "$W/got4.lua" --seconds 10 -- offer red $LU $LT $RU "$W/red_small.lua" 6
[ $RUST_RC = 0 ] && grep -q '^OFFER ' "$W/rust.log" && same "$W/red_small.lua" "$W/got4.lua" && ok "4 lua OFFER -> rust ACCEPT" || bad "4 lua offers"

# 5. one-way broadcast, rust deaf to nothing but echo: Rust sends no HELLO
#    targets; Lua's HELLO reaches Rust, Rust's unicast echo finds Lua
"$PEER" --udp $RU --tcp $RT --game red --target 127.0.0.1:9 --serve "$W/red.lua" --seconds 8 > "$W/rust.log" 2>&1 & rp=$!
luajit "$DRV" "$NET_LUA" pull red $LU $LT $RU "$W/got5.lua" 10 > "$W/lua.log" 2>&1; LUA_RC=$?
wait $rp
[ $LUA_RC = 0 ] && same "$W/red.lua" "$W/got5.lua" && ok "5 one-way: lua finds rust through rust's echo" || bad "5 one-way (rust echo)"

# 6. the other way round: Lua sends no HELLO targets; Rust's HELLO reaches
#    Lua, Lua's echo finds Rust, Rust pulls
run "one-way lua" --game red --target 127.0.0.1:$LU --pull --out "$W/got6.lua" --seconds 10 -- serve red $LU $LT - "$W/red_small.lua" 6
[ $RUST_RC = 0 ] && same "$W/red_small.lua" "$W/got6.lua" && ok "6 one-way: rust finds lua through lua's echo" || bad "6 one-way (lua echo)"

# 7. a different game: listed with its game, a GET for it refused
run "wrong game" --game blue --target 127.0.0.1:$LU --serve "$W/red.lua" --seconds 5 -- pullgame red $LU $LT $RU red 8
grep -q "PEER [0-9a-f]* 3ds blue" "$W/lua.log"; g1=$?
grep -q "wrong game" "$W/lua.log"; g2=$?
grep -q "PEER [0-9a-f]* pc red" "$W/rust.log"; g3=$?
[ $g1 = 0 ] && [ $g2 = 0 ] && [ $g3 = 0 ] && ok "7 different game listed with its game; GET refused (wrong game)" || bad "7 wrong game"

# 8. HELLO fields agree: each side's view of the other's save size and CRC
run "hello fields" --game red --target 127.0.0.1:$LU --serve "$W/red.lua" --seconds 4 -- serve red $LU $LT $RU "$W/red_small.lua" 4
SZ=$(stat -c %s "$W/red.lua"); CRC=$(luajit "$W/crc.lua" "$NET_LUA" "$W/red.lua")
SZ2=$(stat -c %s "$W/red_small.lua"); CRC2=$(luajit "$W/crc.lua" "$NET_LUA" "$W/red_small.lua")
grep -q "PEER [0-9a-f]* pc red 127.0.0.1:$LU $SZ2 $CRC2 LUA PEER" "$W/rust.log"; h2=$?
grep -q "PEER [0-9a-f]* 3ds red $SZ $CRC RUST PEER" "$W/lua.log"; h1=$?
[ $h1 = 0 ] && [ $h2 = 0 ] && ok "8 HELLO size/crc/name agree both ways" || bad "8 hello fields"

# 9. the Rust side's UDP port is someone else's: it falls back to a free
#    port, HELLOs from there, and the Lua side still finds it by its echo
cat > "$W/hold.lua" <<'EOF'
local socket = require("socket")
local u = socket.udp(); assert(u:setsockname("*", tonumber(arg[1]))); socket.sleep(tonumber(arg[2]))
EOF
luajit "$W/hold.lua" $RU 12 & hp=$!
sleep 0.5
run "port taken" --game red --target 127.0.0.1:$LU --serve "$W/red.lua" --seconds 8 -- pull red $LU $LT $RU "$W/got9.lua" 10
kill $hp 2>/dev/null; wait $hp 2>/dev/null
[ $LUA_RC = 0 ] && grep -q "^FALLBACK udp" "$W/rust.log" && same "$W/red.lua" "$W/got9.lua" && ok "9 rust's port taken: falls back, lua still finds it and pulls" || bad "9 port taken"

echo "cross: $PASS passed, $FAIL failed"
[ $FAIL = 0 ]
