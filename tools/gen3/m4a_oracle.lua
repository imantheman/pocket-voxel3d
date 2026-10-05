-- Port of gen1recomp src/core/game3/m4a_worker.lua + audio.lua playSe (GPLv3 + additional terms; see crates/pocketvoxel-core/src/gen3/LICENSE.md).
--
-- M4A oracle: renders reference PCM with gen1recomp's own Lua engine
-- (m4a_player / m4a_seq / m4a_mix / m4a_sample), LÖVE-free, for the Rust
-- port's test (crates/pocketvoxel-core/src/gen3/tests.rs).
--
-- Run from the gen1recomp worktree (tools/gen3/m4a_oracle.sh does this):
--   cd ~/gen1recomp-latest && luajit <this> <cacheRoot> <outDir> <rate>
-- <cacheRoot> holds data/generated/gba/audio/. Writes <outDir>/<name>.f64
-- (interleaved L,R little-endian doubles, the raw pre-clip floats the Lua
-- hands to SoundData) and <outDir>/manifest.txt, one line per render:
--   bgm <id> <n>                       worker stream (8192 blocks + "ended")
--   se <id> <n> <loopStart|-1> <loop>  audio.lua playSe's bakeSlot
--   fanfare <id> <n>                   the worker's bakeSong
--   cry <species> <mode> <n> <frames>  Sample.renderCryMix (mono, L = R)

package.path = "./?.lua;./?/init.lua;" .. package.path

local ffi = require("ffi")
local root, outDir, rate = arg[1], arg[2], tonumber(arg[3]) or 44100

local Mix = require("src.core.game3.m4a_mix")
Mix.setSampleRate(rate)
assert(Mix.SAMPLE_RATE == rate, "rate not accepted")
local Player = require("src.core.game3.m4a_player")
local Sample = require("src.core.game3.m4a_sample")

local cache = {
  read = function(_, rel)
    local f = io.open(root .. "/" .. rel, "rb")
    if not f then return nil end
    local s = f:read("*a")
    f:close()
    return s
  end,
}

local pack = assert(Player.loadPack(cache, "data/generated/gba/audio"))
local manifest = assert(io.open(outDir .. "/manifest.txt", "w"))

local function write_f64(name, L, R)
  local n = #L
  local buf = ffi.new("double[?]", n * 2)
  for i = 1, n do
    buf[(i - 1) * 2] = L[i]
    buf[(i - 1) * 2 + 1] = R[i]
  end
  local f = assert(io.open(outDir .. "/" .. name .. ".f64", "wb"))
  f:write(ffi.string(buf, n * 16))
  f:close()
end

-- m4a_worker.lua:181-208: renderBuffered blocks of BUFFER; after a block in
-- which the song is done with no voices and a quiet reverb, the worker
-- queues one silent "ended" block.
local function bgm(id, seconds)
  local slot = { voices = {}, seq = nil, songId = id, muted = false, volume = 1, abs = 0 }
  Player.start(pack, cache, slot, id, { forceSeq = true })
  local total = math.floor(rate * seconds)
  local L, R = {}, {}
  local silent = false
  local BUFFER = Player.BUFFER_SAMPLES
  while #L < total do
    local m = math.min(BUFFER, total - #L)
    if silent then
      for _ = 1, m do L[#L + 1] = 0; R[#R + 1] = 0 end
      silent = false
    else
      local l, r = Player.renderBuffered(slot, m, { master = 1, sampleRate = rate, raw = true })
      for i = 1, m do L[#L + 1] = l[i]; R[#R + 1] = r[i] end
      if slot.done and #(slot.voices or {}) == 0 and not Mix.reverbActive(slot.reverbState) then
        silent = true
      end
    end
  end
  write_f64("bgm_" .. id, L, R)
  manifest:write(string.format("bgm %d %d\n", id, #L))
end

-- audio.lua:1132 Audio._songHasGoto
local function song_has_goto(slot)
  if slot and slot.info and slot.info.hasGoto ~= nil then return slot.info.hasGoto end
  local seq = slot and slot.seq
  if not seq or not seq.tracks then return false end
  for _, tr in ipairs(seq.tracks) do
    local data = tr.data
    if type(data) == "string" and data:find(string.char(0xB2), 1, true) then
      return true
    end
  end
  return false
end

-- audio.lua:939-963 (playSe's bake; SE_LOW_HEALTH = 83, SE_EXP = 27)
local function se(id)
  local slot = { voices = {} }
  assert(Player.start(pack, cache, slot, id, { forceSeq = true }), "SE missing")
  local loop = (id == 83) or song_has_goto(slot)
  local loopBody = loop and id ~= 83
  local cut = ((loop and not loopBody) or id == 27)
  local maxSec = cut and 2.5 or 30
  local L, R, loopStart = Player.bakeSlot(slot, {
    raw = true,
    maxSec = maxSec,
    stopOnGoto = loop and true or false,
    loopBody = loopBody,
  })
  write_f64("se_" .. id, L, R)
  manifest:write(string.format("se %d %d %d %d\n", id, #L, loopStart or -1, loop and 1 or 0))
end

-- m4a_worker.lua:141 bake_fanfare
local function fanfare(id)
  local ff = pack.index.fanfares
  local e = ff and (ff[id] or ff[tostring(id)])
  local frames = (e and e.frames) or 160
  local L, R = Player.bakeSong(pack, cache, id, { raw = true, sampleRate = rate, maxSec = frames / 60 + 4 })
  write_f64("fanfare_" .. id, L, R)
  manifest:write(string.format("fanfare %d %d\n", id, #L))
end

-- audio.lua:1325 playCry → Sample.renderCry (mono when pan is 0)
local function cry(species, mode)
  local slot = assert(Player.startCry(pack, species, { pitch = 1.0 }))
  local c = pack.index.cries[slot.info.cryIndex]
  local meta = pack.samples[c.sampleId]
  local pcm = Sample.loadPcm(pack.samplesBin, meta)
  local params = Sample.cryParams(mode, nil, nil)
  local out, info = Sample.renderCryMix(pcm, Mix.waveRate(meta.freq), params, { outRate = rate })
  write_f64(string.format("cry_%d_%d", species, mode), out, out)
  manifest:write(string.format("cry %d %d %d %.17g\n", species, mode, #out, info.frames))
end

-- Sweep mode: every song as a 2 s BGM stream, every SE's playSe bake and
-- every species' cry (mode 0), each reduced to an FNV-1a hash over its
-- doubles' 32-bit words (lo, hi; L then R per sample) -> sweep.txt:
--   hbgm <id> <n> <hash> / hse <id> <n> <loopStart|-1> <loop> <hash> /
--   hcry <species> <n> <frames> <hash>
local bit = require("bit")
local function fnv(L, R)
  local n = #L
  local buf = ffi.new("double[?]", n * 2)
  for i = 1, n do
    buf[(i - 1) * 2] = L[i]
    buf[(i - 1) * 2 + 1] = R[i]
  end
  local w = ffi.cast("uint32_t *", buf)
  local h = bit.tobit(2166136261)
  for i = 0, n * 4 - 1 do
    h = bit.bxor(h, w[i])
    h = bit.tobit(bit.lshift(h, 24) + h * 403)
  end
  return bit.tohex(h)
end

if arg[4] == "sweep" then
  manifest:close()
  local sweep = assert(io.open(outDir .. "/sweep.txt", "w"))
  local BUFFER = Player.BUFFER_SAMPLES
  for id = 0, pack.index.songCount - 1 do
    local slot = { voices = {}, songId = id, muted = false, volume = 1, abs = 0 }
    Player.start(pack, cache, slot, id, { forceSeq = true })
    local total, L, R, silent = math.floor(rate * 2), {}, {}, false
    while #L < total do
      local m = math.min(BUFFER, total - #L)
      if silent then
        for _ = 1, m do L[#L + 1] = 0; R[#R + 1] = 0 end
        silent = false
      else
        local l, r = Player.renderBuffered(slot, m, { master = 1, sampleRate = rate, raw = true })
        for i = 1, m do L[#L + 1] = l[i]; R[#R + 1] = r[i] end
        if slot.done and #(slot.voices or {}) == 0 and not Mix.reverbActive(slot.reverbState) then silent = true end
      end
    end
    sweep:write(string.format("hbgm %d %d %s\n", id, #L, fnv(L, R)))
    local info = pack.index.songs[id]
    if info and info.kind == "se" then
      local s = { voices = {} }
      if Player.start(pack, cache, s, id, { forceSeq = true }) then
        local loop = (id == 83) or song_has_goto(s)
        local loopBody = loop and id ~= 83
        local cut = ((loop and not loopBody) or id == 27)
        local SL, SR, ls = Player.bakeSlot(s, { raw = true, maxSec = cut and 2.5 or 30,
          stopOnGoto = loop and true or false, loopBody = loopBody })
        sweep:write(string.format("hse %d %d %d %d %s\n", id, #SL, ls or -1, loop and 1 or 0, fnv(SL, SR)))
      end
    end
  end
  for species = 1, 411 do
    local slot = Player.startCry(pack, species, { pitch = 1.0 })
    if slot then
      local c = pack.index.cries[slot.info.cryIndex]
      local meta = pack.samples[c.sampleId]
      local pcm = Sample.loadPcm(pack.samplesBin, meta)
      local out, info = Sample.renderCryMix(pcm, Mix.waveRate(meta.freq), Sample.cryParams(0), { outRate = rate })
      sweep:write(string.format("hcry %d %d %.17g %s\n", species, #out, info.frames, fnv(out, out)))
    end
  end
  sweep:close()
  print("m4a oracle: sweep written to " .. outDir)
  os.exit(0)
end

if rate == 44100 then
  bgm(278, 12)   -- MUS_TITLE
  bgm(300, 12)   -- MUS_PALLET
  bgm(298, 12)   -- MUS_VS_WILD
  bgm(291, 8)    -- MUS_ROUTE1
  bgm(257, 4)    -- MUS_LEVEL_UP on the BGM player: ends, "ended" blocks
  fanfare(257)   -- MUS_LEVEL_UP
  fanfare(256)   -- MUS_HEAL
  for _, id in ipairs({ 1, 5, 27, 43, 47, 83, 125, 146, 200 }) do se(id) end
  cry(1, 0)
  cry(25, 2)
  cry(6, 4)
  cry(150, 9)
else
  bgm(300, 8)
  fanfare(257)
  se(5)
  se(43)
  cry(25, 2)
end
manifest:close()
print("m4a oracle: wrote " .. outDir .. " at " .. rate .. " Hz")
