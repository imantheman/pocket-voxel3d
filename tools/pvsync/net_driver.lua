-- Test tool, not shipped: drives the PC mod's own transport (its net.lua,
-- loaded at run time from the path given -- nothing of it is in this repo)
-- against pocket-voxel's Rust PVS1 implementation (pvsync-peer). Used by
-- tools/pvsync/cross_test.sh.
--
--   luajit net_driver.lua <net.lua> <mode> <game> <udp> <tcp> <targetPort|-> [file] [seconds]
--
-- modes: serve <file>    serve <file> until the time runs out
--        offer <file>    serve, and OFFER it to the first same-game peer
--        pull <out>      pull the first same-game peer into <out>, exit 0
--        accept <out>    pull the first peer that OFFERs into <out>, exit 0
--        pullgame <g>    pull the first peer asking for game <g>; prints the error
-- Each event is one line on stdout.
local socket = require("socket")
local bit = require("bit")

local path, mode, game, udp, tcp, target, file, seconds = ...
seconds = tonumber(seconds or "20")
math.randomseed(os.time() + tonumber(udp))
local net = dofile(path)(socket, bit)

local body
if mode == "serve" or mode == "offer" then
  local f = assert(io.open(file, "rb")); body = f:read("*a"); f:close()
end

local function say(s) io.stdout:write(s, "\n"); io.stdout:flush() end
local done, status = false, 1

local session
session = net.new({
  udpPort = tonumber(udp), tcpPort = tonumber(tcp), bindHost = os.getenv("PVS_BIND") or "*",
  targets = (target ~= "-") and { { "127.0.0.1", tonumber(target) } } or {},
  info = function() return { platform = "pc", game = game, name = "Lua Peer", body = body } end,
  onOffer = function(peer)
    say("OFFER " .. peer.name)
    if mode == "accept" then
      local ok, err = session:pull(peer, game)
      say(ok and ("PULLING " .. peer.name) or ("FAILED " .. tostring(err)))
    end
  end,
  onPulled = function(peer, got)
    say(("PULLED %s %d %s"):format(peer.name, #got, net.crc32(got)))
    if file and (mode == "pull" or mode == "accept") then
      local f = assert(io.open(file, "wb")); f:write(got); f:close()
    end
    done, status = true, 0
  end,
  onError = function(msg)
    say("FAILED " .. msg)
    done, status = true, (mode == "pullgame") and 0 or 1
  end,
})
local ok, err = session:open()
if not ok then say("ERROR " .. tostring(err)); os.exit(2) end
say("READY id=" .. session.id)

local seen, acted = {}, false
local t0 = socket.gettime()
local last = t0
while not done do
  local now = socket.gettime()
  if now - t0 > seconds then
    if mode == "serve" or mode == "offer" then say("DONE"); status = 0 else say("FAILED timeout") end
    break
  end
  session:tick(now - last)
  last = now
  for _, p in ipairs(session:peerList()) do
    if not seen[p.id] then
      seen[p.id] = true
      say(("PEER %s %s %s %d %s %s"):format(p.id, p.platform, p.game, p.size, p.crc, p.name))
    end
    if not acted and (p.game == game or mode == "pullgame") then
      if mode == "pull" then
        acted = true
        local ok2, e = session:pull(p, game)
        say(ok2 and ("PULLING " .. p.name) or ("FAILED " .. tostring(e)))
      elseif mode == "pullgame" then
        acted = true
        session:pull(p, file)
        say("PULLING " .. p.name .. " for " .. file)
      elseif mode == "offer" then
        acted = true
        session:offer(p)
        say("OFFERED " .. p.name)
      end
    end
  end
  socket.sleep(0.016)
end
session:close()
os.exit(status)
